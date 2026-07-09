// 患者 Agent —— 只表演,不算数值。数值全部来自状态机注入的 GameState。
import type { ChatMessage } from '../llm/client';
import { patientLLM } from '../llm';
import { mockPatientReply } from '../mock/patientMock';
import type { CaseCard, GameState } from '../game/types';

export interface PatientCtx {
  kind: 'greeting' | 'ask' | 'turn_end' | 'op_result';
  question?: string;
  revealedKey?: string | null;
  /** 发生的事实(操作+结果+持续影响)——只给事实,情绪由患者 LLM 自己判 */
  recentEvents?: string[];
}

export interface DialogueTurn {
  role: 'doctor' | 'patient';
  text: string;
}

// 只描述身体状态对说话的影响,性格一律交给病例卡的 personality 字段
function speechStyle(s: GameState): string {
  if (s.phase === 'dead') return '(已死亡,不应说话)';
  if (s.phase === 'cured' || s.phase === 'recovering') return '虚弱但轻松,带着劫后余生的放松';
  if (s.phase === 'critical' || s.hp <= 30) return '危急:断断续续,一次只能挤出几个字,几乎叫不应,大量省略';
  if (s.hp < 50) return '说话带喘,句子短,时不时哼哼,能感到在硬撑';
  return '身体尚可,按你的性格正常说话';
}

// 鉴别接诊模式:装病者的演技段落(普通病例为空串,提示词与原来完全一致)
function deceptionSection(c: CaseCard, s: GameState): string {
  const d = c.deception;
  if (!d?.isFake) return '';
  return `
【绝密设定 —— 你在装病,医生不知道】
- 你身体健康,动机:${d.motive}。你声称自己得了「${d.claimedDisease}」,此行目的:${d.goal}。
- 你按普通人对「${d.claimedDisease}」的想象来表演症状,细节可能不符合医学——因为你不懂医学,这正是你会穿帮的地方。
- 心理侧写:${d.psychProfile}
- 上面【当前说话方式】描述的是你真实的身体状态;你要在此之上"叠加"对所装疾病的表演(喊疼、捂住、皱眉),但真实的底子藏不干净。
- 信息保险箱里的条目是你的**破绽**:当系统要求你"自然透露"某条时,把它作为口误/前后矛盾/表演穿帮演出来,让医生能察觉,而你本人浑然不觉或急忙找补,绝不复述条目原文。
- 已被医生抓到的破绽:${s.revealed.length} 条。0 条时从容自信;1 条时开始心虚、找补;2 条及以上再被当面对质时,你可以崩溃承认。除此之外**绝不主动承认**——被质疑时先圆谎,再恼羞成怒。
- 若医生提出手术、穿刺等有创操作,你会强烈抗拒推脱(既怕露馅又怕真挨刀),抗拒方式符合你的性格。
- 「禁止主动说出疾病名称」一条对你不适用:主动声称「${d.claimedDisease}」是骗局的一部分,你甚至会引导医生往这个病上想。`;
}

function buildSystem(c: CaseCard, s: GameState, ctx: PatientCtx): string {
  const notRevealed = c.hiddenAsk.filter((h) => !s.revealed.includes(h.key));
  const revealed = c.hiddenAsk.filter((h) => s.revealed.includes(h.key));
  const g = c.patient.guardian;
  return `你是医疗诊断模拟游戏中的患者NPC,只负责"表演"对话,绝不计算数值、绝不推动剧情。

【角色】${c.patient.name},${c.patient.age}岁,${c.patient.gender}。性格:${c.patient.personality}。${
    g
      ? `
【陪同家属】${g.relation},性格:${g.personality}。你要**同时扮演患者和家属两个人**:
- 每句话必须带说话人前缀,如"(${g.relation})…"或"(${c.patient.name.slice(-2)})…",谁开口由情境决定
- 分工:病史、时间线、接触史、既往史主要由家属代诉(受其性格影响,可能夸大、抢答或漏细节);主观感受(哪里疼、什么感觉)由患者本人表达${c.patient.age < 14 ? ',儿童用词简单、碎片化' : ''}${s.phase === 'critical' || s.hp <= 30 ? ';患者当前几乎说不出话,以家属为主' : ''}
- 家属不知道的事就说不清楚,不许编造;信息保险箱规则对两人同样生效
- 病情越重,家属越急`
      : ''
  }
【当前身体状态】HP ${s.hp}/100,阶段:${s.phase}。生命体征:心率${s.vitals.hr}、体温${s.vitals.temp}℃。
【当前说话方式】${speechStyle(s)}
${deceptionSection(c, s)}
【信息保险箱 —— 严格遵守】
1. 可以主动提及的不适:${c.volunteered.join('、')}
2. 以下症状只有医生问到对应问题时才能透露(每次最多透露一条):
${notRevealed.map((h) => `   - 「${h.desc}」——仅当医生${h.unlock}时`).join('\n') || '   (均已透露)'}
${revealed.length ? `3. 已经告诉过医生的:${revealed.map((h) => h.desc).join('、')}(可自然重复)` : ''}
4. 你完全不懂医学:体征(如反跳痛)、化验指标(如白细胞)你永远说不出来也不能确认,被问到就用自己的话表示不懂、让医生自己看。

【禁止】主动说出任何疾病名称;一次交代全部症状;承认自己是AI或游戏角色;替医生做判断;**重复或近似重复你之前说过的话——每次开口必须有新的内容或新的表达**。
【输出】只输出患者说的一句话。必须只有一句,不要第二句,不要分点,不要解释;可以带一个很短的括号内动作神态。口语化,语气、用词、说不说方言完全由年龄和性格决定。${
    ctx.kind === 'ask' && ctx.revealedKey
      ? `\n【本轮指令】医生的提问命中了解锁条件,你必须在回答中自然透露:「${c.hiddenAsk.find((h) => h.key === ctx.revealedKey)?.desc}」`
      : ''
  }`;
}


function keepOneSentence(text: string) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const match = cleaned.match(/^(.{1,80}?[。！？!?]|.{1,42}(?:$|[，,、；;]))/);
  return (match?.[1] || cleaned.slice(0, 42)).trim();
}
function buildUser(ctx: PatientCtx): string {
  switch (ctx.kind) {
    case 'greeting':
      return '(场景:你来到急诊诊室,在医生对面坐下——怎么来的、情不情愿,由你的性格决定)请开口向医生描述你的不舒服,开场方式要符合你的性格。';
    case 'ask':
      return `医生问你:「${ctx.question}」`;
    case 'turn_end': {
      const ev = ctx.recentEvents?.length
        ? `这段时间发生了:${ctx.recentEvents.join(';')}。(这些是幕后信息——你只能感知到发生在自己身上的部分,且不懂医学,不要说出数字、指标或术语,用身体感受表达)`
        : '';
      return `(一段时间过去了,病情在变化)${ev}请结合刚发生的事和你当下的身体感受,只说一句话,禁止第二句,禁止重复你之前说过的话。`;
    }
    case 'op_result': {
      const ev = ctx.recentEvents?.length ? `刚发生的事:${ctx.recentEvents.join(';')}。` : '';
      return `(医生刚对你做了一次处置)${ev}(这些是幕后信息,你不懂医学,只按它对你身体的实际影响来反应——好转就表达缓解,受了创伤就表达痛苦,两者都有就都体现,情绪由你自己判断)只说一句真实反应,不要说第二句,不要说数字和术语,不要重复之前说过的话。`;
    }
  }
}

/**
 * 流式生成患者台词。真 LLM 不可用或失败时回落到 Mock 剧本。
 * @returns 'llm' | 'mock' —— 实际使用的通道
 */
export async function streamPatientReply(
  c: CaseCard,
  s: GameState,
  ctx: PatientCtx,
  history: DialogueTurn[],
  onDelta: (chunk: string) => void
): Promise<'llm' | 'mock'> {
  if (patientLLM) {
    try {
      const messages: ChatMessage[] = [
        { role: 'system', content: buildSystem(c, s, ctx) },
        ...history.slice(-8).map(
          (h): ChatMessage => ({
            role: h.role === 'doctor' ? 'user' : 'assistant',
            content: h.text,
          })
        ),
        { role: 'user', content: buildUser(ctx) },
      ];
      let full = '';
      await patientLLM.chatStream(messages, (d) => {
        full += d;
      });
      const one = keepOneSentence(full);
      if (one) {
        onDelta(one);
        return 'llm';
      }
    } catch (e) {
      console.warn('[patientAgent] LLM 失败,回落 Mock:', e);
    }
  }
  // Mock 兜底:整段文本逐字回吐
  const text = keepOneSentence(mockPatientReply(c, s, ctx));
  for (const ch of text) {
    onDelta(ch);
    await new Promise((r) => setTimeout(r, 30));
  }
  return 'mock';
}
