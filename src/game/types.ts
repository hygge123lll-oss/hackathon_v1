// 核心数据结构 —— 状态机是唯一事实来源,LLM 只做表演

export type Phase = 'active' | 'critical' | 'recovering' | 'dead' | 'cured';

export interface Vitals {
  hr: number;
  bpSys: number;
  bpDia: number;
  temp: number;
  spo2: number;
}

export interface HiddenSymptom {
  key: string;
  desc: string;
  unlock: string;
  /** Mock 判定层的关键词兜底(LLM 不可用时) */
  keywords?: string[];
}

export interface ResultRow {
  name: string;
  value: string;
  ref?: string;
  abnormal?: boolean;
}

export interface ResultCard {
  id: string;
  title: string;
  turn: number;
  rows: ResultRow[];
  note?: string;
}

export interface ExamDef {
  key: string;
  label: string;
  reveals?: string; // hidden_exam key
  /** 患者立绘上的身体热区:点击/按压患者身体直接触发本检查 */
  zone?: 'chest' | 'abdomen';
  /** 需要患者躺在床上完成(隐含"请躺好"医嘱,自动挪人) */
  onBed?: boolean;
  result: Omit<ResultCard, 'id' | 'turn'>;
  maskedResult?: Omit<ResultCard, 'id' | 'turn'>; // 被止痛药掩盖时的失真结果
}

export interface LabDef {
  key: string;
  label: string;
  reveals?: string; // hidden_lab key
  /** 需要患者躺在床上完成(隐含"请躺好"医嘱,自动挪人) */
  onBed?: boolean;
  result: Omit<ResultCard, 'id' | 'turn'>;
}

export interface MedDef {
  key: string;
  label: string;
  hpDelta: number;
  rateDelta: number;
  durationTurns: number | null; // null = 永久
  mask?: 'pain' | 'fever';
  // 延迟后果:效果到期后追加的永久恶化(核心卖点)
  onExpire?: { rateDelta: number; label: string };
  sideEffectNote?: string;
  /** 本药是该病例的正确处置(如过敏性休克的肾上腺素)→ 用药即进入恢复期 */
  cure?: boolean;
}

export interface SurgeryDef {
  key: string;
  label: string;
  correct: boolean;
  // 正确手术的"有依据"要求:已揭示其中任一 key
  requiresAny?: string[];
  wrongHpDelta?: number;
  wrongEffect?: { rateDelta: number; label: string };
}

/**
 * 鉴别接诊模式:真假病人档案。缺省 = 普通模式,引擎与各 Agent 完全忽略该字段。
 * 除 isFake(开局代码抽签、整局冻结)外,所有内容由出题 LLM 每局现场生成,不做枚举。
 */
export interface DeceptionProfile {
  isFake: boolean;
  /** 以下仅诈病病例存在 */
  motive?: string; // 装病动机(自由生成:骗假条/骗药/逃避某事…)
  claimedDisease?: string; // 他声称/表演的疾病
  psychProfile?: string; // 心理侧写:多沉得住气、被质疑时的反应、什么情况下会崩
  goal?: string; // 他具体想从医生手里拿到什么(得逞判定的依据)
}

export interface CaseCard {
  caseId: string;
  trueDiagnosis: string;
  patient: {
    name: string;
    age: number;
    gender: string;
    personality: string;
    /** 陪同家属(儿童/意识障碍患者必备):病史主要由其代诉,由患者 Agent 一并扮演 */
    guardian?: { relation: string; personality: string };
  };
  initialHp: number;
  deteriorationRate: number;
  volunteered: string[];
  hiddenAsk: HiddenSymptom[];
  hiddenExam: HiddenSymptom[];
  hiddenLab: HiddenSymptom[];
  exams: ExamDef[];
  labs: LabDef[];
  meds: MedDef[];
  surgeries: SurgeryDef[];
  vitalsBase: Vitals;
  /** 参考示范路线 —— 仅是众多可行路线之一,评估时不得当唯一标准 */
  referencePath: string[];
  /** 决策原则 —— 所有正确路线都必须满足的公共约束,评估的主锚点 */
  principles: string[];
  /** 本病例的陷阱说明,注入评估/专家 Agent 提示词 */
  evalNotes: string;
  /** 结构化评分表:总分 = 达标权重加权和(代码计算,LLM 只做判定题) */
  rubric: RubricCriterion[];
  /** 鉴别接诊模式专用,普通病例省略 */
  deception?: DeceptionProfile;
}

export interface RubricCriterion {
  id: string;
  domain: string; // 如 病史采集 / 客观依据 / 处置决策 / 资源使用
  label: string;
  weight: number; // 1~3
  /** 达标定义 —— 给评估 Agent 的判定口径,全部标准由 LLM 对照 timeline 判定 */
  evidence: string;
}

export interface ActiveEffect {
  id: string;
  source: string;
  label: string;
  rateDelta: number;
  remaining: number | null; // null = 永久
  mask?: 'pain' | 'fever';
  onExpire?: { rateDelta: number; label: string };
  /** 医源性并发症(错误手术/有害操作造成):正确处置治病,治不了你造的伤,穿透恢复期 */
  persistent?: boolean;
}

export interface TimelineEntry {
  turn: number;
  action: 'ask' | 'exam' | 'lab' | 'medicate' | 'surgery' | 'system';
  detail: string;
  result: string;
}

export interface GameState {
  turn: number;
  hp: number;
  hpMax: number;
  phase: Phase;
  apLeft: number;
  vitals: Vitals;
  revealed: string[];
  doneExams: string[];
  doneLabs: string[];
  activeEffects: ActiveEffect[];
  timeline: TimelineEntry[];
  recoverTurns: number; // recovering 阶段已撑过的回合数
  expertCallsLeft: number;
}

/**
 * 后果处方 —— 菜单外自定义操作的后果由判定层 LLM 依医学常识现场开出,
 * 引擎只做记账员:校验范围、存入账本、逐回合结转。
 */
export interface Prescription {
  /** 即时 HP 变化。伤害为负;有益支持封顶 +3(自定义操作不可能成为治愈路线) */
  hp_delta: number;
  /** 几乎必然致死的操作(切除大脑/静推大剂量氯化钾等)→ 当场死亡 */
  death: boolean;
  /** 持续效果(后遗症/并发症/支持作用),无则 null */
  ongoing: {
    label: string;
    rate: number; // 每回合 HP 变化,引擎夹紧 -6~+2
    duration: number | null; // 回合数,null=永久
    /** 原发病被正确治愈时该效果是否随之消除;与原发病无关的医源性损伤应为 false */
    cured_by_treatment: boolean;
  } | null;
  /** 本操作能消除的既有持续影响(按效果名),如清创缝合处理术后感染;无则省略 */
  resolves?: string[] | null;
  /** 一句话医学理由,写入 timeline */
  rationale: string;
}

export type PlayerAction =
  | { type: 'ask'; text: string }
  | { type: 'exam'; key: string }
  | { type: 'lab'; key: string }
  | { type: 'medicate'; key: string }
  | { type: 'surgery'; key: string }
  | { type: 'custom_exam'; label: string; prescription: Prescription }
  | { type: 'custom_med'; label: string; prescription: Prescription }
  | { type: 'custom_surgery'; label: string; prescription: Prescription };

export type GameEvent =
  | { type: 'reveal'; key: string; desc: string }
  | { type: 'card'; card: ResultCard }
  | { type: 'hp'; delta: number; hp: number }
  | { type: 'phase'; phase: Phase }
  | { type: 'note'; text: string }
  | { type: 'ask_context'; revealedKey: string | null; question: string };

export const AP_COST: Record<PlayerAction['type'], number> = {
  ask: 1,
  exam: 1,
  lab: 1,
  medicate: 1,
  surgery: 2,
  custom_exam: 1,
  custom_med: 1,
  custom_surgery: 2,
};
