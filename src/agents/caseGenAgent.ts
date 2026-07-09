import { caseGeneratorLLM } from '../llm';
import { validateCaseCard } from '../game/caseSchema';
import type { CaseCard } from '../game/types';
import type { ChatMessage } from '../llm/client';

export type CaseDifficulty = 'basic' | 'advanced' | 'challenge';

export interface RandomCaseGenerationInput {
  mode: 'random';
  difficulty: CaseDifficulty;
  /** 科室限定;不传或"随机"= 代码从科室池抽签 */
  dept?: string;
  /** 主诉方向限定;不传 = 代码从该科方向池抽签(鉴别接诊模式传入,与假病例共用抽签结果) */
  direction?: string;
  /** 额外硬约束,逐字附加到出题提示词末尾(鉴别接诊模式用) */
  extraDirective?: string;
}

// 科室池:每科附"主诉方向池",生成前由代码抽签正向注入,治多样性收敛(否则总出腹痛)
const DEPT_DIRECTIONS: Record<string, string[]> = {
  呼吸科: ['呼吸困难', '咯血', '剧烈咳嗽伴高热'],
  心血管内科: ['胸痛', '心悸', '晕厥'],
  神经科: ['突发意识障碍', '剧烈头痛', '单侧肢体无力'],
  消化科: ['腹痛', '呕血', '黄疸'],
  内分泌科: ['昏迷', '多饮多尿伴消瘦', '心慌大汗'],
  泌尿外科: ['血尿', '剧烈腰痛', '突发无尿'],
  感染科: ['高热寒战', '高热伴皮疹', '高热伴意识模糊'],
  妇产科: ['阴道出血', '停经后腹痛', '孕期剧烈头痛伴视物模糊'],
  儿科: ['高热惊厥', '拒食嗜睡', '哭闹不安伴呕吐'],
  普外科: ['外伤后腹痛', '腹部包块', '肛周剧痛伴发热'],
};
/** 给 UI 用的科室列表(不含"随机",由 UI 自己加) */
export const CASE_DEPARTMENTS = Object.keys(DEPT_DIRECTIONS);

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

export interface CustomCaseGenerationInput {
  mode: 'custom';
  patient: {
    name: string;
    gender: string;
    age: number;
    personality: string;
  };
  disease: string;
}

export type CaseGenerationInput = RandomCaseGenerationInput | CustomCaseGenerationInput;

export interface CaseGenerationResult {
  ok: true;
  card: CaseCard;
}

export interface CaseGenerationError {
  ok: false;
  errors: string[];
}

export type CaseGeneration = CaseGenerationResult | CaseGenerationError;

const DIFFICULTY_PROMPTS: Record<CaseDifficulty, string> = {
  basic:
    '基础:线索直接,恶化较慢。initialHp 建议 75~85,deteriorationRate 建议 -3~-4。关键病史或查体容易获得,干扰项少,正确处置路径明确,适合练习标准流程。',
  advanced:
    '进阶:需要问诊、查体、检查至少两类证据组合判断。initialHp 建议 60~75,deteriorationRate 建议 -5~-7。有 1~2 个合理干扰项,处置存在时间压力。',
  challenge:
    '挑战:早期表现不典型或线索隐蔽,恶化快。initialHp 建议 45~65,deteriorationRate 建议 -7~-10。干扰检查、药物或术式更多,错误处置代价高,rubric 强调时间窗和避免错误处置。',
};

const COMPLEXITY_PROMPT =
  '自定义病例的难度不由玩家选择。请根据疾病本身复杂度、急危重程度、鉴别诊断难度和处置时间窗,自行设定 initialHp、deteriorationRate、干扰项数量、检查菜单、药物/手术陷阱和 rubric 权重。常见轻症可偏基础,急危重症或表现不典型者应偏进阶/挑战。';

const cleanJson = (text: string) => {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型没有返回 JSON 对象');
  return cleaned.slice(start, end + 1);
};

function parseCaseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(cleanJson(raw)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'JSON 解析失败' };
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function normalizeGeneratedCase(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const card = structuredClone(value) as Record<string, unknown>;

  if (!Array.isArray(card.surgeries)) card.surgeries = [];
  if (!Array.isArray(card.exams)) card.exams = [];
  if (!Array.isArray(card.labs)) card.labs = [];
  if (!Array.isArray(card.meds)) card.meds = [];

  for (const listName of ['exams', 'labs'] as const) {
    for (const item of card[listName] as unknown[]) {
      if (!isRecord(item)) continue;
      if (item.zone === '') delete item.zone;
      if (item.onBed === '') delete item.onBed;
      const label = typeof item.label === 'string' ? item.label : '检查结果';
      if (isRecord(item.result) && typeof item.result.title !== 'string') item.result.title = label;
      if (isRecord(item.maskedResult) && typeof item.maskedResult.title !== 'string') item.maskedResult.title = `${label}(受干扰)`;
    }
  }

  for (const item of card.meds as unknown[]) {
    if (!isRecord(item)) continue;
    if (item.durationTurns === undefined) item.durationTurns = null;
    if (item.mask === '') delete item.mask;
  }

  // 触诊类查体的 3d 场景兜底:模型常漏 zone/onBed,漏了会导致开单后既不上床也没有按压交互
  const exams = card.exams as unknown[];
  if (!exams.some((e) => isRecord(e) && e.zone === 'abdomen')) {
    const palp = exams.find(
      (e) =>
        isRecord(e) &&
        typeof e.label === 'string' &&
        (/触诊|按压/.test(e.label) || (/腹/.test(e.label) && /查体|体格|压痛/.test(e.label)))
    );
    if (palp && isRecord(palp)) palp.zone = 'abdomen';
  }
  for (const e of exams) if (isRecord(e) && e.zone === 'abdomen') e.onBed = true;

  return card;
}

function buildUserPrompt(input: CaseGenerationInput): string {
  if (input.mode === 'random') {
    // 代码抽签定方向,LLM 命题作文:科室和主诉方向是硬约束,压制范例锚定导致的收敛
    const dept = input.dept && DEPT_DIRECTIONS[input.dept] ? input.dept : pick(CASE_DEPARTMENTS);
    const direction = input.direction ?? pick(DEPT_DIRECTIONS[dept]);
    // 主任难度 15% 概率:非典型表现(真病灶伪装成别科症状,经典漏诊陷阱)
    const atypical = input.difficulty === 'challenge' && Math.random() < 0.15;
    return `请生成一个急诊教学病例。
场景:急诊单人接诊
本次出题限定(硬约束):
- 科室:${dept}——必须是该科适合急诊单人接诊、不处置会持续恶化的急症
- 主诉方向:${direction}——开场主诉围绕它展开,医学合理时可带伴随症状${
      dept === '儿科'
        ? '\n- 患者是儿童:说话口吻符合年龄,只能表达碎片化主观感受;必须提供 patient.guardian(陪同家长),病史主要由家长代诉,家长人设要影响问诊(如焦虑夸大/粗心漏细节);hiddenAsk 的线索按"谁知道"合理分配给孩子或家长'
        : ''
    }${
      atypical
        ? '\n- 特别要求(非典型表现):真实病灶属于本科,但主诉表现得像其他系统的病(如下壁心梗表现为上腹痛),并在 rubric 中加入"识破非典型表现"的评分项'
        : ''
    }
难度要求:${DIFFICULTY_PROMPTS[input.difficulty]}${input.extraDirective ? `\n${input.extraDirective}` : ''}`;
  }

  return `请基于以下玩家自定义基础信息生成一个完整急诊教学病例。
患者姓名:${input.patient.name}
患者性别:${input.patient.gender}
患者年龄:${input.patient.age}
患者人格/沟通风格:${input.patient.personality}
指定疾病:${input.disease}

生成要求:
- 必须保留玩家提供的姓名、性别、年龄、人格和指定疾病;trueDiagnosis 应围绕该疾病,可补充分型/病因但不得换成其他疾病。
- 初始主诉 volunteered 必须是患者入院时能自然说出的症状,不得泄露诊断名。
- ${COMPLEXITY_PROMPT}`;
}

const SYSTEM_PROMPT = `你是急诊医学教学游戏的病例设计器。你必须只输出一个严格 JSON 对象,不得输出 Markdown 或解释。
目标:生成一个可直接用于游戏引擎的 CaseCard。

硬性结构:
{
  "caseId": "generated_短英文_时间戳或随机后缀",
  "trueDiagnosis": "真实诊断",
  "patient": {"name":"中文姓名","age":数字,"gender":"男/女/其他","personality":"具体患者人设和沟通风格","guardian":{"relation":"称谓如 孩子妈妈/患者妻子","personality":"家属人设,影响代诉质量,如 焦虑护犊爱抢答/冷静条理"}(仅当患者是儿童(<14岁)或无法自主对话(昏迷/意识障碍/严重构音障碍)时必填,其余省略该字段)},
  "initialHp": 45~85,
  "deteriorationRate": -3~-10,
  "volunteered": ["初始主诉1","初始主诉2"],
  "hiddenAsk": [{"key":"snake_case","desc":"问出来的关键病史","unlock":"该问什么会解锁","keywords":["中文关键词"]}],
  "hiddenExam": [{"key":"snake_case","desc":"查体发现","unlock":"对应查体"}],
  "hiddenLab": [{"key":"snake_case","desc":"检查/化验发现","unlock":"对应检查"}],
  "exams": [{
    "key":"snake_case",
    "label":"查体名称",
    "reveals":"hiddenExam里的key",
    "zone":"chest 或 abdomen,可省略;全病例最多一个 chest 和一个 abdomen",
    "onBed":true,
    "result":{"title":"标题","rows":[{"name":"项目","value":"结果","ref":"参考范围","abnormal":true}]},
    "maskedResult":{"title":"标题","rows":[{"name":"项目","value":"被止痛药掩盖后的结果","ref":"参考范围","abnormal":false}]}
  }],
  "labs": [{
    "key":"snake_case",
    "label":"化验或影像名称",
    "reveals":"hiddenLab里的key",
    "onBed":true,
    "result":{"title":"标题","rows":[{"name":"项目","value":"结果","ref":"参考范围","abnormal":true}]}
  }],
  "meds": [{"key":"snake_case","label":"药物名称","hpDelta":0,"rateDelta":0,"durationTurns":1或null,"mask":"pain或fever,可省略","onExpire":{"rateDelta":-2,"label":"延迟恶化"},"sideEffectNote":"说明","cure":true或省略}],
  "surgeries": [{"key":"snake_case","label":"术式","correct":true或false,"requiresAny":["hidden key"],"wrongHpDelta":-30,"wrongEffect":{"rateDelta":-4,"label":"并发症"}}],
  "vitalsBase": {"hr":数字,"bpSys":数字,"bpDia":数字,"temp":数字,"spo2":数字},
  "referencePath": ["推荐路线步骤"],
  "principles": ["决策原则"],
  "evalNotes": "评分/陷阱说明",
  "rubric": [{"id":"dg-01","domain":"病史采集","label":"标准","weight":1~3,"evidence":"如何根据timeline判定"}]
}

3d 场景字段要求:
- 腹部触诊/压痛/反跳痛等体格检查应设置 "zone":"abdomen"。
- 胸痛、呼吸困难、心肺听诊等适合点击胸部触发的体格检查应设置 "zone":"chest"。
- 全病例最多一个 chest 热区检查和一个 abdomen 热区检查。
- 需要患者躺到床上的检查或床旁检查设置 "onBed":true。不要给所有项目都设置 onBed,只在医学和场景上合理时使用。

病例设计要求:
- patient.personality 必须是 40~90 个汉字的可执行对话人设,不得只写标签。必须包含语言风格、情绪状态、配合度、背景身份或生活压力、是否使用方言/口头禅。
- 不同年龄必须有明显不同口吻。年轻人不要默认像老人,儿童不要成人化,老年人也不要一律喊叫或哭穷。
- 除非 personality 明确要求,不要生成"哎呦""大夫别开贵检查""身子骨硬朗"这类老年模板。
- 至少 2 个 hiddenAsk,1 个 hiddenExam,1 个 hiddenLab。
- 至少 2 个 exams,2 个 labs,3 个 meds。
- 至少有一个治愈路径:med.cure=true 或 surgeries 中 correct=true。
- 如果 correct surgery 有 requiresAny,只能引用 hiddenAsk/hiddenExam/hiddenLab 中真实存在的 key。
- 所有 key 必须 snake_case 且互不重复。
- 检查报告要有静态基准结果,不要把结果写成"待定"。
- 药物/手术要有教学陷阱,但不能胡编离谱医学。
- rubric 至少 6 条,覆盖病史、证据、处置、资源使用。
- 输出中文内容,JSON 字段名保持英文。
- JSON 必须完整闭合,数组元素和对象属性之间必须有逗号,不得出现尾逗号。`;

export async function generateCase(
  input: CaseGenerationInput,
  onProgress?: (message: string) => void
): Promise<CaseGeneration> {
  if (!caseGeneratorLLM) {
    return { ok: false, errors: ['当前未配置 LLM,无法自动生成病例。请配置 VITE_LLM_BASE_URL 和 VITE_LLM_API_KEY。'] };
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(input) },
  ];

  let lastRaw = '';
  let lastErrors: string[] = [];
  let lastKind: 'structure' | 'network' = 'structure'; // 返工原因分类,进度提示要说实话
  for (let attempt = 0; attempt < 3; attempt++) {
    onProgress?.(
      attempt === 0
        ? '出题人正在编写病例...'
        : lastKind === 'network'
          ? `网络繁忙,正在重试第 ${attempt + 1} 次...`
          : `病例结构有问题,正在返工第 ${attempt + 1} 次...`
    );
    try {
      const raw = await caseGeneratorLLM.chat(messages, {
        maxTokens: 9000,
        temperature: attempt === 0 ? 0.45 : 0.15,
        json: true,
      });
      lastRaw = raw;
      const parsed = parseCaseJson(raw);
      if (!parsed.ok) {
        lastErrors = [parsed.error];
      } else {
        const validated = validateCaseCard(normalizeGeneratedCase(parsed.value));
        if (validated.ok) return { ok: true, card: validated.card };
        lastErrors = validated.errors;
      }
      lastKind = 'structure';
      console.warn(`[caseGen] 第 ${attempt + 1} 轮未过:`, lastErrors.slice(0, 8));

      messages.push({ role: 'assistant', content: raw.slice(0, 12000) });
      messages.push({
        role: 'user',
        content: `上一次输出不可用。请只返回修正后的完整 JSON 对象,不要解释。
错误:
${lastErrors.slice(0, 12).join('\n')}

修复要求:
- 保留同一个病例设定,但必须返回完整、合法、可 JSON.parse 的 JSON。
- 不要 Markdown 代码块。
- 不要省略任何 CaseCard 字段。
- 不要尾逗号,数组和对象必须正确闭合。
- 3d 字段 zone/onBed 只在合适时出现,zone 最多一个 chest 和一个 abdomen。`,
      });
    } catch (e) {
      lastErrors = [e instanceof Error ? e.message : '病例生成失败'];
      lastKind = 'network'; // 请求层异常(限流/超时/认证),不是病例结构问题
      console.warn(`[caseGen] 第 ${attempt + 1} 轮请求失败:`, lastErrors[0]?.slice(0, 120));
    }
  }

  const tail = lastRaw ? ` 原始输出末尾:${lastRaw.slice(-160)}` : '';
  return { ok: false, errors: [...lastErrors, `已自动重试 3 次仍失败。${tail}`] };
}
