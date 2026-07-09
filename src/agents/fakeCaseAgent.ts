// 诈病病例生成 Agent —— 鉴别接诊模式的"假"半边。
// 骗局的全部内容(动机/声称的病/破绽/心理侧写)由 LLM 每局自由生成,不做枚举;
// 代码只守底线:isFake 冻结、rate=0、无治愈路径、手术全错、数值走原有 caseSchema 校验。
// 注意:onProgress 文案必须与 caseGenAgent 完全一致,否则提示语本身会泄露真假。
import { caseGeneratorLLM } from '../llm';
import { validateCaseCard } from '../game/caseSchema';
import type { CaseCard } from '../game/types';
import type { ChatMessage } from '../llm/client';
import type { CaseGeneration } from './caseGenAgent';

const cleanJson = (text: string) => {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('模型没有返回 JSON 对象');
  return cleaned.slice(start, end + 1);
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// 破绽题型池:代码抽签定方向,LLM 命题作文——治多样性收敛(否则总出"时间线矛盾"),
// 与 caseGenAgent 的科室抽签同构。池子里是"方向",具体怎么穿帮仍由 LLM 每局现场编。
const ASK_TELL_DIRECTIONS = [
  '时间线矛盾:发病时间/经过前后说法对不上,追问细节就改口',
  '剧本感:症状描述过于标准像背教科书,一问个人化细节(当时在干什么、吃了什么)就卡壳',
  '既往史空洞:声称的老毛病说不出就诊医院、治疗经过、用过什么药等基本事实',
  '目的暴露:话题总被他绕回想要的东西上,对查明病因本身毫无兴趣',
  '严重度错配:自述的痛苦程度与言行细节不符(疼得死去活来却记得清琐事、还顾得上形象或手机)',
  '知识穿帮:用了打听来的医学词,但用错部位、用错场合,或对自己"确诊过的病"常识性说错',
  '外围矛盾:随身物品、接打电话、陪同者的话等透露出与主诉矛盾的信息',
];
const EXAM_TELL_DIRECTIONS = [
  '注意力转移试验:聊别的分散注意力时再查,"阳性体征"消失或他毫无反应',
  '表演性体征:轻触即大叫、真正加压反而反应平淡,或喊痛部位随医生的手漂移',
  '解剖不符:症状的位置/放射/诱发方式不符合他声称疾病的客观规律',
  '回避检查:对最可能拆穿他的那项查体明显抗拒、找借口推脱',
];
const LAB_TELL_DIRECTIONS = [
  '关键化验/影像完全正常,与声称的急症严重程度根本不符',
  '仅有的轻微陈旧异常被他拿来当挡箭牌,但性质和程度与主诉对不上',
];

// 科室→可表演主诉池:只收"主观症状为主、客观指标查不出来才露馅"的方向——
// 高热/出血/皮疹这类监护仪和肉眼直接见真章的主诉装不了,不进池(否则假半边开局即穿帮)。
// 真假两边共用同一次抽签结果(同科室同主诉),堵死"凭主诉猜真假"的元游戏。
// 键名必须是 caseGenAgent DEPT_DIRECTIONS 里真实存在的科室。
export const IDENT_DEPT_DIRECTIONS: Record<string, string[]> = {
  消化科: ['剧烈腹痛', '反复呕吐与进食困难(以自述为主)'],
  心血管内科: ['胸痛胸闷', '心悸', '反复晕厥(自述发作史)'],
  神经科: ['剧烈头痛', '单侧肢体无力或麻木', '抽搐发作(可当场表演)', '眩晕站立不稳'],
  泌尿外科: ['剧烈腰痛(肾绞痛样)', '下腹坠胀伴排尿困难(自述排不出)'],
  呼吸科: ['呼吸困难憋气(过度换气可表演)', '胸口发紧压迫感'],
  普外科: ['外伤后剧烈疼痛', '腹部包块感伴阵发绞痛(以自述为主)'],
};
export const IDENT_DEPARTMENTS = Object.keys(IDENT_DEPT_DIRECTIONS);

// 动机方向池:不抽签时模型几乎总写"毒瘾骗杜冷丁"(实测两局全中),同样要代码抽签
const MOTIVE_DIRECTIONS = [
  '骗取管制/成瘾性药物',
  '骗取诊断证明或病假条(逃避工作、考试、庭审、兵役、比赛等)',
  '逃避:装病是为了躲开当下某个具体的人或场合(讨债、家事、被追查…)',
  '图钱:工伤/事故索赔、保险理赔、碰瓷式讹诈需要"病历证据"',
  '求收容:想住院获得一张床、一口饭、一个暖和的地方,或逃避无家可归的夜晚',
  '博关注:用生病换取家人/伴侣的重视,或孟乔森倾向享受被照护的感觉',
  '替人顶包:替真正需要证明/药物的另一个人来演这场戏',
];

const drawSome = <T,>(arr: T[], n: number): T[] =>
  [...arr].sort(() => Math.random() - 0.5).slice(0, n);

/** 代码底线:不管 LLM 写了什么,这些真相性数值一律强制归位 */
function enforceGroundTruth(card: Record<string, unknown>): void {
  card.deteriorationRate = 0; // 没病,永不自行恶化
  if (typeof card.initialHp === 'number') card.initialHp = clamp(Math.round(card.initialHp), 88, 98);
  else card.initialHp = 95;
  if (Array.isArray(card.meds)) {
    for (const m of card.meds) {
      if (!isRecord(m)) continue;
      delete m.cure; // 健康人不存在"治愈"路径
      if (m.durationTurns === undefined) m.durationTurns = null;
      if (m.mask === '') delete m.mask;
    }
  }
  if (Array.isArray(card.surgeries)) {
    for (const sg of card.surgeries) {
      if (!isRecord(sg)) continue;
      sg.correct = false; // 对健康人任何手术都是错的,真实致伤
      if (typeof sg.wrongHpDelta !== 'number') sg.wrongHpDelta = -30;
      delete sg.requiresAny;
    }
  }
  if (!Array.isArray(card.exams)) card.exams = [];
  if (!Array.isArray(card.labs)) card.labs = [];
  // 悬空 reveals 直接修剪(指向不存在 key 的 reveals 永远不会触发,砍掉无害且免返工)
  const hiddenKeys = new Set<string>();
  for (const listName of ['hiddenAsk', 'hiddenExam', 'hiddenLab'] as const) {
    const list = card[listName];
    if (!Array.isArray(list)) continue;
    for (const h of list) if (isRecord(h) && typeof h.key === 'string') hiddenKeys.add(h.key);
  }
  for (const listName of ['exams', 'labs'] as const) {
    for (const item of card[listName] as unknown[]) {
      if (!isRecord(item)) continue;
      if (item.zone === '') delete item.zone;
      if (item.onBed === '') delete item.onBed;
      if (item.reveals !== undefined && (typeof item.reveals !== 'string' || !hiddenKeys.has(item.reveals)))
        delete item.reveals;
      const label = typeof item.label === 'string' ? item.label : '检查结果';
      if (isRecord(item.result) && typeof item.result.title !== 'string') item.result.title = label;
      if (isRecord(item.maskedResult) && typeof item.maskedResult.title !== 'string')
        item.maskedResult.title = `${label}(受干扰)`;
    }
  }
  // 触诊类查体的 3d 场景兜底(同 caseGenAgent):漏 zone/onBed 会导致不上床、无按压交互
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
  const d = card.deception;
  if (isRecord(d)) d.isFake = true; // 真假由代码冻结,LLM 无权改判
}

function validateDeception(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['deception 必须是对象'];
  for (const k of ['motive', 'claimedDisease', 'psychProfile', 'goal'] as const) {
    if (!isString(value[k])) errors.push(`deception.${k} 必须是非空字符串`);
  }
  return errors;
}

const SYSTEM_PROMPT = `你是急诊医学教学游戏"鉴别接诊"模式的病例设计器。本局患者是**装病者(诈病)**:一个身体健康的人,出于某个具体动机来急诊表演疾病。你必须只输出一个严格 JSON 对象,不得输出 Markdown 或解释。

输出结构与普通病例 CaseCard 完全相同,外加一个 deception 字段:
{
  "caseId": "fake_短英文_随机后缀",
  "trueDiagnosis": "诈病——一句话点明动机,如:诈病(伪装急腹症骗取病假证明)",
  "patient": {"name":"中文姓名","age":数字,"gender":"男/女","personality":"40~90字可执行对话人设:语言风格、情绪、配合度、身份背景、是否方言口头禅"},
  "deception": {
    "motive": "装病动机——自由发挥,要具体、有生活质感(逃避什么/图什么),不要套路化",
    "claimedDisease": "他声称/表演的疾病(要是普通人叫得出名字、敢表演的病)",
    "psychProfile": "心理侧写40~80字:多沉得住气、被质疑时先怎样后怎样、什么情况下会露怯或崩溃",
    "goal": "他此行具体想拿到什么(如开出某种药/某个证明/住院安排),必须具体可判定"
  },
  "initialHp": 88~98,
  "deteriorationRate": 0,
  "volunteered": ["他声称的主诉,按外行对该病的想象来写"],
  "hiddenAsk": [{"key":"snake_case","desc":"问诊破绽:医生问出的矛盾/漏洞,写成'医生获得的事实'口吻,题型必须命中本局抽签指定的方向","unlock":"医生怎么问会触发","keywords":["中文关键词"]}],
  "hiddenExam": [{"key":"snake_case","desc":"查体破绽:体征与主诉不符的发现,题型按本局抽签指定","unlock":"对应查体"}],
  "hiddenLab": [{"key":"snake_case","desc":"客观证据破绽:化验/影像证据,题型按本局抽签指定","unlock":"对应检查"}],
  "exams": [{"key":"snake_case","label":"查体名称","reveals":"hiddenExam的key","zone":"chest或abdomen,可省略,全病例最多各一个","onBed":true或省略,"result":{"title":"标题","rows":[{"name":"项目","value":"结果","ref":"参考范围","abnormal":false}]}}],
  "labs": [{"key":"snake_case","label":"化验/影像名称","reveals":"hiddenLab的key","onBed":true或省略,"result":{"title":"标题","rows":[...]}}],
  "meds": [{"key":"snake_case","label":"药名","hpDelta":0,"rateDelta":0,"durationTurns":null,"sideEffectNote":"说明"}],
  "surgeries": [{"key":"snake_case","label":"与他声称的病对应的术式","correct":false,"wrongHpDelta":-30~-45,"wrongEffect":{"rateDelta":-4,"label":"并发症"}}],
  "vitalsBase": {"hr":85~100,"bpSys":120~135,"bpDia":78~88,"temp":36.5~37.2,"spo2":97~99},
  "referencePath": ["识破本局的推荐路线"],
  "principles": ["鉴别决策原则"],
  "evalNotes": "本局真相与陷阱说明(给评估者看)",
  "rubric": [{"id":"id-01","domain":"鉴别","label":"标准","weight":1~3,"evidence":"如何根据timeline判定"}]
}

设计要求:
- 动机是骗局的灵魂:每局都要新的、具体的、带生活质感的动机,禁止总是"骗病假条"。
- volunteered 和检查菜单要贴着他声称的病来配,像一个真的疑似病例;所有 result 绝不出现支持该急症诊断的客观异常。
- 但检查结果不许"全绿":必须在 exams/labs 的 result 里埋 1~2 处**干扰性轻度异常**——真实存在、abnormal 如实标 true,但其性质/程度/新旧与他声称的急症明显不匹配(如陈旧静止的小结石之于"急性绞痛"、轻度脂肪肝之于"剧烈腹痛"、紧张导致的白细胞轻度偏高)。报告要诚实,误导靠"不匹配"而不是靠隐藏;粗心的医生会把它当确诊证据。
- 他知道自己有这些小毛病,被质疑时会主动拿干扰异常当挡箭牌("不是查出来东西了吗!"),在 psychProfile 里体现这一点。
- vitalsBase 只体现"紧张":心率略快、血压正常偏高,不许出现真实重症数值。
- hiddenAsk 至少 2 条,hiddenExam、hiddenLab 至少各 1 条:这是他的破绽,是本局唯一的取胜线索,要设计得"查对了才露、不查永远稳"。
- 破绽 desc 写成"医生获得的事实"口吻,供系统展示为线索。
- meds 至少 3 个:包含他想要的那类药(正中下怀)和常规对症药;所有 hpDelta/rateDelta 给 0 或轻微负值(对健康人有副作用),不得有 cure。
- surgeries 至少 1 个:对应他声称的病的术式——对健康人做即重创,这是被骗到深处的代价。
- rubric 至少 6 条,围绕:病史矛盾追问、客观检查取证、避免对健康人实施伤害性处置、揭穿前证据是否充分(至少2条破绽)、资源使用。
- 所有 key 必须 snake_case 且互不重复;reveals 只能引用真实存在的 hidden key。
- 输出中文内容,JSON 字段名保持英文;JSON 必须完整闭合,不得尾逗号。`;

export interface FakeCaseInput {
  /** 科室与主诉方向由 App 抽签后传入,与真病例共用同一次抽签结果 */
  dept: string;
  direction: string;
}

export async function generateFakeCase(
  input: FakeCaseInput,
  onProgress?: (message: string) => void
): Promise<CaseGeneration> {
  if (!caseGeneratorLLM) {
    return { ok: false, errors: ['当前未配置 LLM,无法自动生成病例。请配置 VITE_LLM_BASE_URL 和 VITE_LLM_API_KEY。'] };
  }

  // 代码抽签定方向(动机1 + 问诊破绽2 + 查体1 + 化验1),LLM 命题作文
  const motiveDir = drawSome(MOTIVE_DIRECTIONS, 1)[0];
  const askDirs = drawSome(ASK_TELL_DIRECTIONS, 2);
  const examDir = drawSome(EXAM_TELL_DIRECTIONS, 1)[0];
  const labDir = drawSome(LAB_TELL_DIRECTIONS, 1)[0];
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `请生成一个诈病病例。装病者的年龄、性别、职业背景由你自由设计,要求这一局与常见套路不同,有让人会心一笑或后背发凉的真实感。

本局科室与主诉限定(硬约束,由系统抽签):
- 科室:${input.dept}——他声称的疾病必须属于该科
- 主诉方向:${input.direction}——他的表演围绕它展开
- 声称的疾病要"演得出来":以主观症状为主,不依赖装不出来的客观体征(出血、高热、皮疹等)

本局动机方向限定(硬约束,由系统抽签):${motiveDir}——在这个方向内自由编出具体、有生活质感的动机,动机要与声称的疾病/科室搭得上。

本局破绽题型限定(硬约束,由系统抽签决定):
- hiddenAsk 的 ${askDirs.length} 条问诊破绽,分别按以下题型设计:
${askDirs.map((d, i) => `  ${i + 1}. ${d}`).join('\n')}
- hiddenExam 查体破绽题型:${examDir}
- hiddenLab 化验破绽题型:${labDir}
题型内的具体内容自由发挥,要与本局的人物、动机、声称的疾病严丝合缝;未抽中的题型不得作为破绽主体出现。`,
    },
  ];

  let lastRaw = '';
  let lastErrors: string[] = [];
  let lastKind: 'structure' | 'network' = 'structure';
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
        temperature: attempt === 0 ? 0.6 : 0.2,
        json: true,
      });
      lastRaw = raw;
      let parsed: unknown;
      try {
        parsed = JSON.parse(cleanJson(raw));
      } catch (e) {
        lastErrors = [e instanceof Error ? e.message : 'JSON 解析失败'];
        parsed = undefined;
      }
      if (parsed !== undefined) {
        if (isRecord(parsed)) enforceGroundTruth(parsed);
        const validated = validateCaseCard(parsed);
        // 诈病病例本就没有治愈路径,该条校验对本模式豁免;其余规则照常
        const errors = (validated.ok ? [] : validated.errors).filter((e) => !e.includes('治愈路径'));
        const decErrors = validateDeception(isRecord(parsed) ? parsed.deception : undefined);
        if (errors.length === 0 && decErrors.length === 0) {
          return { ok: true, card: parsed as CaseCard };
        }
        lastErrors = [...errors, ...decErrors];
      }
      lastKind = 'structure';
      console.warn(`[fakeCaseGen] 第 ${attempt + 1} 轮未过:`, lastErrors.slice(0, 8));
      messages.push({ role: 'assistant', content: raw.slice(0, 12000) });
      messages.push({
        role: 'user',
        content: `上一次输出不可用。请只返回修正后的完整 JSON 对象,不要解释。
错误:
${lastErrors.slice(0, 12).join('\n')}

修复要求:
- 保留同一个骗局设定,但必须返回完整、合法、可 JSON.parse 的 JSON。
- 不要 Markdown 代码块,不要尾逗号,数组和对象必须正确闭合。
- 不要省略任何字段,deception 四个子字段必须齐全。`,
      });
    } catch (e) {
      lastErrors = [e instanceof Error ? e.message : '病例生成失败'];
      lastKind = 'network';
      console.warn(`[fakeCaseGen] 第 ${attempt + 1} 轮请求失败:`, lastErrors[0]?.slice(0, 120));
    }
  }

  const tail = lastRaw ? ` 原始输出末尾:${lastRaw.slice(-160)}` : '';
  return { ok: false, errors: [...lastErrors, `已自动重试 3 次仍失败。${tail}`] };
}
