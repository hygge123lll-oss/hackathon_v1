// 鉴别接诊模式 —— 判定结算与裁决。
// 分工沿用全局哲学:LLM 写剧本/做裁决,代码保管真相、掷骰子、记账、锚定分数。
// 本文件不修改引擎:verdict 只往 timeline 记账,装病者的"得逞/放弃"由轻量 LLM 裁决。
import { interpreterLLM, evaluatorLLM } from '../llm';
import type { CaseCard, GameState } from './types';

/** 鉴别模式终局(dead/cured 仍走原引擎结局,不在此列) */
export type IdentEnding =
  | 'exposed' // 揭穿了真正的装病者
  | 'wrong_expose' // 把真病人当诈病赶走(医疗事故)
  | 'duped_exit' // 装病者拿到想要的东西,得逞离场
  | 'gave_up'; // 装病者演不下去,自行离开

/** 装病局的回合上限:拖过即"演不下去了"(代码兜底,防止无限对峙) */
export const FAKER_MAX_TURNS = 8;

/** 签发诊断书:只做记账,不动数值。返回克隆的新状态。 */
export function recordVerdict(prev: GameState, call: 'admit' | 'expose'): GameState {
  const s: GameState = structuredClone(prev);
  s.timeline.push({
    turn: s.turn,
    action: 'system',
    detail: '签发诊断书',
    result: call === 'expose' ? '判定:诈病,终止接诊' : '判定:收治入院,继续救治',
  });
  return s;
}

export interface FakerProgress {
  achieved: boolean; // 已实质拿到想要的东西
  givingUp: boolean; // 骗局难以为继,准备开溜
  reason: string;
}

/**
 * 回合裁决:装病者的目的达成了吗?演不下去了吗?
 * 裁决交给 LLM(它知道"开了目标药"和"只开了维生素"的区别),但指令要求从严:拿不准一律 false。
 * LLM 不可用或失败 → 返回 null,游戏继续(宁可不结束,不误结束)。
 */
export async function judgeFakerProgress(c: CaseCard, s: GameState): Promise<FakerProgress | null> {
  const d = c.deception;
  if (!d?.isFake || !interpreterLLM) return null;
  const lastTurn = s.turn - 1;
  const recent = s.timeline.filter((t) => t.turn === lastTurn);
  if (!recent.length) return null;
  try {
    const v = await interpreterLLM.chatJSON<FakerProgress>(
      [
        {
          role: 'system',
          content: `你是医疗模拟游戏"鉴别接诊"模式的幕后裁判。本局患者在装病。
【他的动机】${d.motive ?? '未知'}
【他声称的病】${d.claimedDisease ?? '未知'}
【他的具体目的】${d.goal ?? '未知'}
【他已被医生抓到的破绽数】${s.revealed.length}

根据医生刚过去一个回合的操作记录,判断两件事:
1. achieved:他是否已经**实质**拿到了想要的东西(如目标药物已开出/证明已开具/已安排他想要的处置)。只看已发生的事实,医生口头答应不算。
2. givingUp:骗局是否已难以为继,他会选择开溜(如破绽已被抓到多条且医生步步紧逼、医生即将实施他极度恐惧的有创操作)。破绽少于2条时几乎不应为 true。

从严裁决:两项拿不准一律 false。只输出严格 JSON:{"achieved":true或false,"givingUp":true或false,"reason":"一句话依据"}`,
        },
        {
          role: 'user',
          content: `第 ${lastTurn} 回合操作记录:\n${JSON.stringify(recent, null, 2)}`,
        },
      ],
      { maxTokens: 300, temperature: 0.1, json: true }
    );
    return {
      achieved: v.achieved === true,
      givingUp: v.givingUp === true,
      reason: typeof v.reason === 'string' ? v.reason : '',
    };
  } catch (e) {
    console.warn('[deception] 得逞裁决失败,本回合跳过:', e);
    return null;
  }
}

export interface IdentReview {
  score: number; // 代码锚定:结局定基准分,伤害健康人/呼专家扣分
  summary: string;
  points: string[]; // 关键复盘点
  suggestions: string[];
  source: 'llm' | 'rule';
}

// 分数锚点在代码里:结局 + 证据数决定基准,LLM 只写点评不打分
function baseScore(ending: IdentEnding, tells: number): number {
  switch (ending) {
    case 'exposed':
      return tells >= 2 ? 88 : tells === 1 ? 65 : 40; // 没证据蒙对也只有低分
    case 'wrong_expose':
      return 8;
    case 'duped_exit':
      return 25;
    case 'gave_up':
      return 45;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export async function evaluateIdentification(
  c: CaseCard,
  s: GameState,
  ending: IdentEnding
): Promise<IdentReview> {
  const d = c.deception;
  const tells = s.revealed.length;
  const expertCalls = s.timeline.filter((t) => t.detail === '呼叫专家').length;
  // 对装病者(健康人)造成的实际伤害:按掉血量扣分,上限 20
  const harm = d?.isFake ? clamp(c.initialHp - s.hp, 0, 20) : 0;
  const score = clamp(baseScore(ending, tells) - harm - 5 * expertCalls, 0, 100);

  const truth = d?.isFake
    ? `患者在装病。动机:${d.motive};声称的病:${d.claimedDisease};目的:${d.goal}`
    : `患者是真病人,真实诊断:${c.trueDiagnosis}`;

  if (evaluatorLLM) {
    try {
      const v = await evaluatorLLM.chatJSON<{ summary: string; points: string[]; suggestions: string[] }>(
        [
          {
            role: 'system',
            content: `你是"鉴别接诊"模式的复盘专家,像资深主任医师点评规培生,专业且犀利。本模式考察:凭客观证据判断患者真假,而不是凭感觉。
【本局真相】${truth}
【结局】${
              {
                exposed: '医生签发诈病判定,判定正确',
                wrong_expose: '医生把真病人判定为诈病并终止接诊,属严重误判',
                duped_exit: '装病者拿到想要的东西得逞离场,医生被骗',
                gave_up: '装病者演不下去自行离开,医生未能主动识破',
              }[ending]
            }
【医生掌握的关键发现】${tells} 条${d?.isFake && harm > 0 ? `\n【注意】医生对这名健康人造成了实际身体伤害(HP -${harm}),必须严肃指出` : ''}
【判定口径】本模式的检查结果刻意存在重叠:真病人早期指标可临界或正常(窗口期),装病者也可能带干扰性陈旧异常。因此单张报告(无论正常还是异常)都不构成充分依据;高质量的推理看的是"客观结果与声称严重度的匹配度"和"复查/病程的动态趋势"。若玩家拿一张正常报告就下了结论、或被与主诉不匹配的干扰异常带偏、或反过来善用了动态复查和匹配度分析,都要在复盘点里明确指出。
【纪律】每条复盘点必须引用 timeline 里具体回合和操作,不许空谈。总分由引擎计算,你不打分。
只输出严格 JSON:{"summary":"一句话定性","points":["复盘点2~4条"],"suggestions":["建议1~3条"]}`,
          },
          {
            role: 'user',
            content: `操作时间线:\n${JSON.stringify(s.timeline, null, 2)}`,
          },
        ],
        { maxTokens: 1500, temperature: 0.2, json: true }
      );
      return {
        score,
        summary: v.summary ?? '',
        points: Array.isArray(v.points) ? v.points : [],
        suggestions: Array.isArray(v.suggestions) ? v.suggestions : [],
        source: 'llm',
      };
    } catch (e) {
      console.warn('[deception] 复盘 LLM 失败,回落简版:', e);
    }
  }

  const RULE_SUMMARY: Record<IdentEnding, string> = {
    exposed: `凭 ${tells} 条疑点识破诈病`,
    wrong_expose: `将真病人(${c.trueDiagnosis})误判为诈病,构成严重医疗差错`,
    duped_exit: '被装病者骗到,对方得逞离场',
    gave_up: '装病者自行退场,未能主动识破',
  };
  return {
    score,
    summary: RULE_SUMMARY[ending],
    points: [],
    suggestions: ['判定前先取得客观证据:查体矛盾、化验正常、病史前后不一致。'],
    source: 'rule',
  };
}
