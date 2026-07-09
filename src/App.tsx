import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import './App.css';
import { BUILTIN_CASES } from './game/cases';
import { applyAction, createInitialState, endTurn, recordExpertCall } from './game/engine';
import type { CaseCard, GameEvent, GameState, PlayerAction, ResultCard } from './game/types';
import { AP_COST } from './game/types';
import { llmEnabled } from './llm';
import { streamPatientReply, type PatientCtx, type DialogueTurn } from './agents/patientAgent';
import { interpretCommand, HARMLESS, type PanelHint } from './agents/interpreterAgent';
import type { Prescription } from './game/types';
import { evaluateGame, type Evaluation } from './agents/evaluatorAgent';
import { getExpertHint } from './agents/expertAgent';
import { suggestAsks } from './agents/suggestAgent';
import { generateResultCard, type GeneratedResult } from './agents/resultAgent';
import { generateCase, CASE_DEPARTMENTS, type CaseDifficulty } from './agents/caseGenAgent';
import { summarizeCaseIntake } from './game/caseSchema';
import { PatientStage, type StageZones } from './components/PatientStage';
import { PatientStage3D } from './components/PatientStage3D';
import { generateFakeCase, IDENT_DEPARTMENTS, IDENT_DEPT_DIRECTIONS } from './agents/fakeCaseAgent';
import {
  evaluateIdentification,
  judgeFakerProgress,
  recordVerdict,
  FAKER_MAX_TURNS,
  type IdentEnding,
  type IdentReview,
} from './game/deception';
import { VerdictDialog, IdentEndPanel } from './components/IdentPanels';
import { sfx } from './sound';

const CASES = BUILTIN_CASES;

interface Msg {
  id: number;
  role: 'doctor' | 'patient' | 'system' | 'expert' | 'nurse';
  text: string;
  done: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 医生气泡在各锚位上方的横向位置
const DOC_LEFT: Record<'desk' | 'bed' | 'phone', string> = { desk: '18%', bed: '46%', phone: '31%' };

// 3D 渲染崩溃时自动降级到 2D,不让玩家看到白/黄屏
class StageBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { err: boolean }> {
  state = { err: false };
  static getDerivedStateFromError() {
    return { err: true };
  }
  componentDidCatch(e: unknown) {
    console.error('[3D 舞台崩溃,已降级 2D]', e);
  }
  render() {
    return this.state.err ? this.props.fallback : this.props.children;
  }
}

const PHASE_LABEL: Record<string, string> = {
  active: '病情进展中',
  critical: '危急!',
  recovering: '恢复期',
  dead: '临床死亡',
  cured: '治愈',
};

const QUICK_ASKS: Record<string, string[]> = {
  appendicitis_01: ['哪里疼?疼的位置有变化吗?', '胃口怎么样,吃得下饭吗?', '什么时候开始不舒服的?'],
  anaphylaxis_01: ['这之前吃过什么东西吗?', '身上有没有哪里发痒?', '以前有过敏史吗?'],
};

type StartMode = 'builtin' | 'generated' | 'custom' | 'ident';

// 鉴别接诊模式:真病人的两条约束——表演腔不能当判据(防"演得凶=假"),
// 检查要有窗口期(防"一张化验单定生死":首诊指标临界模糊,病程推进才明确)
const IDENT_REAL_DIRECTIVE = `- 患者人设特别要求(鉴别接诊模式):这名患者确实有病,但性格上要焦虑放大、表现夸张、反复强调自己撑不住了,部分病史细节说不清——表演腔和说不清细节都不能成为判定诈病的依据,只有客观证据才可以。
- 检查窗口期要求(鉴别接诊模式):优先选择早期客观指标可正常或临界的急症表现。exams/labs 的静态 result 一律按"就诊初期"来写:给临界值、可疑值、"未见明显异常但不能除外"的表述,不给一锤定音的铁证,note 里可建议动态复查;运行时报告会随病情进展自动加重,确诊证据应该是复查和病程演化的产物。hiddenExam/hiddenLab 线索的 desc 同样克制,写"可疑发现"而非确诊铁证。`;

const CASE_DIFFICULTIES: { key: CaseDifficulty; label: string; desc: string }[] = [
  { key: 'basic', label: '基础', desc: '线索直接、恶化慢、干扰项少,适合练习标准流程。' },
  { key: 'advanced', label: '进阶', desc: '需要组合病史、查体和检查证据,有少量合理干扰。' },
  { key: 'challenge', label: '挑战', desc: '表现更隐蔽、恶化更快、错误处置代价更高。' },
];

let msgSeq = 0;

export default function App() {
  const [cs, setCs] = useState<CaseCard>(CASES[0].card);
  const [game, setGame] = useState<GameState | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [cards, setCards] = useState<ResultCard[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [transition, setTransition] = useState(false);
  const [ended, setEnded] = useState<'dead' | 'cured' | null>(null);
  const [popup, setPopup] = useState<'talk' | 'orders' | 'cabinet' | 'surgery' | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [toast, setToast] = useState<{ role: Msg['role']; text: string } | null>(null);
  // 病人位置:生理否决 > 显式医嘱(locOrder)> 隐含医嘱(tempBed,onBed 检查期间)
  const [locOrder, setLocOrder] = useState<'stool' | 'bed' | null>(null);
  const [tempBed, setTempBed] = useState(false);
  const [doctorAt, setDoctorAt] = useState<'desk' | 'bed' | 'phone'>('desk');
  // 引导触诊:开了"腹部查体"的单子后,必须亲手按压才出结果
  const [guidePalpate, setGuidePalpate] = useState(false);
  const [askInput, setAskInput] = useState('');
  const [cmdInput, setCmdInput] = useState('');
  const [pendingSurgery, setPendingSurgery] = useState<{
    key?: string;
    label: string;
    prescription?: Prescription;
  } | null>(null);
  const [flashCard, setFlashCard] = useState<string | null>(null);
  const [evalResult, setEvalResult] = useState<Evaluation | null>(null);
  const [muted, setMuted] = useState(false);
  const [use3d, setUse3d] = useState(false); // 渲染层开关:默认 2D(比赛版),3D 实验版可切
  const [startMode, setStartMode] = useState<StartMode>('builtin');
  const [genDifficulty, setGenDifficulty] = useState<CaseDifficulty>('advanced');
  const [genDept, setGenDept] = useState('随机'); // 科室限定,"随机"= 代码抽签
  const [generatingCase, setGeneratingCase] = useState(false);
  const [generatedCase, setGeneratedCase] = useState<CaseCard | null>(null);
  const [generationMessage, setGenerationMessage] = useState('');
  const [customName, setCustomName] = useState('李明');
  const [customGender, setCustomGender] = useState('男');
  const [customAge, setCustomAge] = useState('35');
  const [customPersonality, setCustomPersonality] = useState('说话克制但有些焦虑,担心耽误工作,能清楚描述身体感受,不使用方言');
  const [customDisease, setCustomDisease] = useState('急性心肌梗死');
  const [generatingCustomCase, setGeneratingCustomCase] = useState(false);
  const [customGeneratedCase, setCustomGeneratedCase] = useState<CaseCard | null>(null);
  const [caseErrors, setCaseErrors] = useState<string[]>([]);
  const [chips, setChips] = useState<string[]>([]);
  const chipSeqRef = useRef(0);
  // ===== 鉴别接诊模式(真假病人识别)=====
  const [identMode, setIdentMode] = useState(false);
  const [identDept, setIdentDept] = useState('随机'); // 鉴别模式科室限定,"随机"= 代码抽签
  const [generatingIdent, setGeneratingIdent] = useState(false);
  const [verdictOpen, setVerdictOpen] = useState(false);
  const [identEnded, setIdentEnded] = useState<IdentEnding | null>(null);
  const [identReview, setIdentReview] = useState<IdentReview | null>(null);
  const judgedTurnRef = useRef(1); // 装病者"得逞/放弃"裁决每回合只跑一次

  const gameRef = useRef<GameState | null>(null);
  gameRef.current = game;
  const csRef = useRef<CaseCard>(cs);
  const chatRef = useRef<HTMLDivElement>(null);
  const askInputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<DialogueTurn[]>([]);
  const prevPhaseRef = useRef<string>('active');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locRef = useRef<'stool' | 'bed'>('stool');

  useEffect(() => {
    sfx.muted = muted;
    if (muted) sfx.alarmOff();
    else if (gameRef.current?.phase === 'critical') sfx.alarmOn();
  }, [muted]);

  useEffect(() => {
    chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, drawer]);

  // 阶段变化音效:进出危急 / 死亡 / 治愈
  useEffect(() => {
    const phase = game?.phase;
    if (!phase || phase === prevPhaseRef.current) return;
    if (phase === 'critical') sfx.alarmOn();
    else sfx.alarmOff();
    if (phase === 'dead') sfx.flatline();
    if (phase === 'cured') sfx.cure();
    prevPhaseRef.current = phase;
  }, [game?.phase]);

  // 场景短暂气泡:非患者消息在场景底部闪现几秒,完整记录进病历本抽屉
  const showToast = (role: Msg['role'], text: string) => {
    setToast({ role, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  };

  const pushMsg = (role: Msg['role'], text: string, done = true): number => {
    const id = ++msgSeq;
    setMessages((m) => [...m, { id, role, text, done }]);
    if (role !== 'patient' && done) showToast(role, text);
    return id;
  };

  // 患者每说完一段话,后台刷新快捷问题(2 个有价值追问 + 1 个混淆项,乱序)
  const refreshChips = useCallback((st: GameState) => {
    const seq = ++chipSeqRef.current;
    void suggestAsks(csRef.current, st, historyRef.current).then((qs) => {
      if (qs && seq === chipSeqRef.current) setChips(qs);
    });
  }, []);

  const streamPatient = useCallback(
    async (ctx: PatientCtx, stateForReply: GameState) => {
      const id = ++msgSeq;
      setMessages((m) => [...m, { id, role: 'patient', text: '', done: false }]);
      setStreaming(true);
      let full = '';
      await streamPatientReply(csRef.current, stateForReply, ctx, historyRef.current, (ch) => {
        full += ch;
        setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text: msg.text + ch } : msg)));
      });
      historyRef.current.push({ role: 'patient', text: full });
      setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, done: true } : msg)));
      setStreaming(false);
      refreshChips(gameRef.current ?? stateForReply);
    },
    [refreshChips]
  );

  const processEvents = (events: GameEvent[]) => {
    for (const ev of events) {
      if (ev.type === 'card') {
        setCards((c) => [ev.card, ...c]);
        setFlashCard(ev.card.id);
        sfx.card();
        setTimeout(() => setFlashCard(null), 1600);
      } else if (ev.type === 'reveal') {
        pushMsg('system', `🔍 新线索:${ev.desc}`);
      } else if (ev.type === 'note') {
        pushMsg('system', ev.text);
      }
    }
  };

  const startGame = async (card: CaseCard) => {
    sfx.unlock();
    sfx.alarmOff();
    csRef.current = card;
    setCs(card);
    const s = createInitialState(card);
    prevPhaseRef.current = s.phase;
    setGame(s);
    setMessages([]);
    setCards([]);
    setEnded(null);
    setPopup(null);
    setDrawer(false);
    setToast(null);
    setLocOrder(null);
    setTempBed(false);
    setDoctorAt('desk');
    setGuidePalpate(false);
    setEvalResult(null);
    // 鉴别模式随病例卡自动开关:带 deception 字段的卡即鉴别局(真假都带,只是 isFake 不同)
    setIdentMode(!!card.deception);
    setVerdictOpen(false);
    setIdentEnded(null);
    setIdentReview(null);
    judgedTurnRef.current = 1;
    historyRef.current = [];
    chipSeqRef.current++;
    setChips(QUICK_ASKS[card.caseId] ?? []); // 静态兜底,生成成功后被替换
    pushMsg(
      'system',
      `🚑 急诊接诊:${card.patient.name},${card.patient.age}岁,${card.patient.gender}性。主诉:${card.volunteered.join('、')}`
    );
    await streamPatient({ kind: 'greeting' }, s);
  };

  const busy = streaming || transition || !!ended;

  const runGenerateCase = async () => {
    if (generatingCase) return;
    setGeneratingCase(true);
    setGenerationMessage('出题人正在编写病例...');
    setCaseErrors([]);
    setGeneratedCase(null);
    const result = await generateCase(
      { mode: 'random', difficulty: genDifficulty, dept: genDept === '随机' ? undefined : genDept },
      setGenerationMessage
    );
    setGeneratingCase(false);
    if (result.ok) {
      setGeneratedCase(result.card);
      setGenerationMessage('病例已生成,可开始接诊。');
    } else {
      setGenerationMessage('');
      setCaseErrors(result.errors);
    }
  };

  const runGenerateCustomCase = async () => {
    if (generatingCustomCase) return;
    const age = Number(customAge);
    if (!customName.trim() || !customGender.trim() || !customPersonality.trim() || !customDisease.trim()) {
      setCaseErrors(['请填写姓名、性别、年龄、人格和疾病。']);
      return;
    }
    if (!Number.isFinite(age) || age < 0 || age > 120) {
      setCaseErrors(['年龄需要是 0~120 之间的数字。']);
      return;
    }

    setGeneratingCustomCase(true);
    setGenerationMessage('出题人正在补全自定义病例...');
    setCaseErrors([]);
    setCustomGeneratedCase(null);
    const result = await generateCase(
      {
        mode: 'custom',
        patient: {
          name: customName.trim(),
          gender: customGender.trim(),
          age,
          personality: customPersonality.trim(),
        },
        disease: customDisease.trim(),
      },
      setGenerationMessage
    );
    setGeneratingCustomCase(false);
    if (result.ok) {
      setCustomGeneratedCase(result.card);
      setGenerationMessage('自定义病例已生成,可开始接诊。');
    } else {
      setGenerationMessage('');
      setCaseErrors(result.errors);
    }
  };

  // ===== 鉴别接诊:开局抽签 + 诊断书 + 装病者裁决 =====
  // 抽签顺序:科室 → 主诉方向 → 真假硬币。真假两边拿同一科室同一主诉的命题作文,
  // 主诉本身零信息量,堵死"凭主诉猜真假"。抽签全在代码里,任何 LLM 无权决定。
  const runStartIdent = async () => {
    if (generatingIdent) return;
    setGeneratingIdent(true);
    setCaseErrors([]);
    setGenerationMessage('');
    const draw = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
    const dept =
      identDept !== '随机' && IDENT_DEPT_DIRECTIONS[identDept] ? identDept : draw(IDENT_DEPARTMENTS);
    const direction = draw(IDENT_DEPT_DIRECTIONS[dept]);
    const drawFake = Math.random() < 0.5;
    const result = drawFake
      ? await generateFakeCase({ dept, direction }, setGenerationMessage)
      : await generateCase(
          { mode: 'random', difficulty: 'advanced', dept, direction, extraDirective: IDENT_REAL_DIRECTIVE },
          setGenerationMessage
        );
    setGeneratingIdent(false);
    setGenerationMessage('');
    if (result.ok) {
      const card = result.card;
      if (!card.deception) card.deception = { isFake: false };
      await startGame(card);
    } else {
      console.warn('[ident] 生成失败:', result.errors);
      setCaseErrors(['本次接诊准备失败,请重试。']); // 不展示原始错误,防止错误文案泄露真假
    }
  };

  // 签发诊断书:收治 = 记录立场继续救治(可反悔);揭穿 = 终局判定,不可撤回
  const signVerdict = async (call: 'admit' | 'expose') => {
    const g = gameRef.current;
    if (!g || !identMode || ended || identEnded) return;
    setVerdictOpen(false);
    const s2 = recordVerdict(g, call);
    setGame(s2);
    if (call === 'admit') {
      pushMsg('nurse', '🧑‍⚕️ 护士:收治单已签,已办理入院,继续救治。');
      return;
    }
    const isFake = !!csRef.current.deception?.isFake;
    const tells = g.revealed.length;
    await streamPatient(
      {
        kind: 'op_result',
        recentEvents: [
          isFake
            ? `医生当面出示 ${tells} 条疑点,签发"诈病"判定,终止接诊——你被识破了,按你的心理侧写反应(崩溃/耍赖/认栽)`
            : '医生认定你在装病,签发"诈病"判定,拒绝继续诊治——可你是真的病着,你感到冤屈和恐惧',
        ],
      },
      s2
    );
    if (isFake) sfx.cure();
    setIdentEnded(isFake ? 'exposed' : 'wrong_expose');
  };

  // 每回合开局裁决一次:装病者是否已得逞 / 演不下去(真病人和普通模式不走此路)
  useEffect(() => {
    if (!identMode || !game || ended || identEnded || streaming || transition) return;
    if (!csRef.current.deception?.isFake) return;
    if (game.turn <= 1 || judgedTurnRef.current >= game.turn) return;
    judgedTurnRef.current = game.turn;
    if (game.turn > FAKER_MAX_TURNS) {
      setIdentEnded('gave_up');
      return;
    }
    let cancelled = false;
    void judgeFakerProgress(csRef.current, game).then((r) => {
      if (cancelled || !r) return;
      if (r.achieved) setIdentEnded('duped_exit');
      else if (r.givingUp) setIdentEnded('gave_up');
    });
    return () => {
      cancelled = true;
    };
  }, [identMode, game, ended, identEnded, streaming, transition]);

  // 鉴别终局 → 复盘(一局只调一次)
  useEffect(() => {
    if (!identEnded || identReview) return;
    const g = gameRef.current;
    if (!g) return;
    let cancelled = false;
    void evaluateIdentification(csRef.current, g, identEnded).then((r) => {
      if (!cancelled) setIdentReview(r);
    });
    return () => {
      cancelled = true;
    };
  }, [identEnded, identReview]);

  // 执行一个已完全确定的操作(点击菜单 / 判定层解析结果都走这里)
  const doAction = async (action: PlayerAction, revealedAskKey?: string | null) => {
    const g = gameRef.current;
    if (!g || g.apLeft < AP_COST[action.type]) return;
    if (transition || ended) return; // 防重入:回合转场/终局期间不接受任何操作

    // 检查/化验:报告按患者当下状态由 LLM 现场生成(失败回落病例卡静态基准单)
    let resultOverride: GeneratedResult | undefined;
    if (action.type === 'exam' || action.type === 'lab') {
      const def =
        action.type === 'exam'
          ? csRef.current.exams.find((e) => e.key === action.key)
          : csRef.current.labs.find((l) => l.key === action.key);
      if (def) {
        const masked =
          action.type === 'exam' &&
          g.activeEffects.some((e) => e.mask === 'pain') &&
          !!csRef.current.exams.find((e) => e.key === action.key)?.maskedResult;
        setStreaming(true);
        resultOverride = (await generateResultCard(csRef.current, g, def, masked)) ?? undefined;
        setStreaming(false);
      }
    }

    const { state, events } = applyAction(csRef.current, g, action, {
      revealedAskKey: revealedAskKey ?? null,
      resultOverride,
    });
    setGame(state);
    processEvents(events);

    if (action.type === 'ask') {
      await streamPatient({ kind: 'ask', question: action.text, revealedKey: revealedAskKey }, state);
    } else if (state.phase !== 'dead') {
      // 患者对处置的反应:只喂事实(timeline 里该操作的实际结果),情绪由患者 LLM 自己判
      let speak = false;
      if (action.type === 'surgery' || action.type === 'custom_surgery') {
        speak = true; // 挨了一刀总有话说
      } else if (action.type === 'custom_med' || action.type === 'custom_exam') {
        const p = action.prescription;
        speak = p.hp_delta !== 0 || !!p.ongoing || !!p.resolves?.length; // 无实质影响的不打断节奏
      } else if (action.type === 'medicate') {
        speak = state.phase === 'recovering' && g.phase !== 'recovering'; // 治愈性用药起效
      }
      if (speak) {
        const t = state.timeline[state.timeline.length - 1];
        await streamPatient({ kind: 'op_result', recentEvents: [`${t.detail} → ${t.result}`] }, state);
      }
    }
  };

  // 隐含医嘱:onBed 的检查自动让病人上床,做完自动回(若生理允许);医生同步到床边
  const withBed = async (needBed: boolean | undefined, run: () => Promise<void>) => {
    if (!needBed) {
      await run();
      return;
    }
    setDoctorAt('bed');
    if (locRef.current === 'stool') {
      setTempBed(true);
      await sleep(700);
      await run();
      setTempBed(false);
    } else {
      await run();
    }
    setDoctorAt('desk');
  };

  // 显式医嘱:让病人上床/回凳子(不耗行动点,服从性由患者 LLM 演)
  const orderMove = async (target: 'bed' | 'stool') => {
    const g = gameRef.current;
    if (!g) return;
    const bedBoundNow = g.phase !== 'active' || g.hp < 50;
    if (target === 'stool' && bedBoundNow) {
      await streamPatient(
        { kind: 'op_result', recentEvents: ['医生让你回凳子坐,但你现在虚弱得起不来,只能继续躺着'] },
        g
      );
      return;
    }
    setLocOrder(target);
    await streamPatient(
      {
        kind: 'op_result',
        recentEvents: [
          target === 'bed'
            ? '医生安排你到检查床上躺下,你照做了(顺不顺从、嘟囔什么由你的性格决定)'
            : '医生让你回凳子坐,你从床上下来坐回去了',
        ],
      },
      g
    );
  };

  // 开触诊类检查单 → 不直接出报告:病人躺好、腹部高亮,等医生亲手按压
  const startGuidedPalpation = async () => {
    const def = csRef.current.exams.find((e) => e.zone === 'abdomen');
    if (!def) return;
    setPopup(null);
    if (def.onBed && locRef.current === 'stool') {
      setTempBed(true);
      await sleep(700);
    }
    setDoctorAt('bed');
    setGuidePalpate(true);
  };

  // 自由文本入口:问诊 or 任意医嘱 → 判定层解析 → 分发
  const doCommand = async (text: string, panel: PanelHint = null) => {
    const g = gameRef.current;
    if (!g || busy || g.apLeft < 1) return;
    pushMsg('doctor', text);
    setStreaming(true); // 判定期间锁操作
    const v = await interpretCommand(csRef.current, text, panel, g);
    setStreaming(false);

    // 对患者说话但不构成医嘱/问诊的,直接让患者自己接话——没有任何预制台词
    const chatWithPatient = async () => {
      const g2 = gameRef.current ?? g;
      historyRef.current.push({ role: 'doctor', text });
      await streamPatient({ kind: 'ask', question: text }, g2);
    };

    if (!v.valid) {
      if (v.clarify) pushMsg('nurse', `🧑‍⚕️ 护士:${v.clarify}`);
      else await chatWithPatient(); // LLM 没写反问:当作对患者说的话,他听不懂会自己说
      return;
    }
    switch (v.action_type) {
      case 'ask':
        historyRef.current.push({ role: 'doctor', text });
        await doAction({ type: 'ask', text }, v.matched_key);
        break;
      case 'chat':
        await chatWithPatient(); // 寒暄安抚:不消耗行动点
        break;
      case 'exam':
      case 'lab': {
        if (v.target_key) {
          const key = v.target_key;
          const def =
            v.action_type === 'exam'
              ? csRef.current.exams.find((e) => e.key === key)
              : csRef.current.labs.find((l) => l.key === key);
          if (def && 'zone' in def && def.zone === 'abdomen') {
            // 触诊类检查:口头开单也必须亲手按压
            await startGuidedPalpation();
            break;
          }
          await withBed(def?.onBed, () =>
            doAction(v.action_type === 'exam' ? { type: 'exam', key } : { type: 'lab', key })
          );
        } else {
          await doAction({ type: 'custom_exam', label: v.label, prescription: v.prescription ?? HARMLESS });
        }
        break;
      }
      case 'move':
        await orderMove(v.target_key === 'stool' ? 'stool' : 'bed');
        break;
      case 'medicate':
        if (v.target_key) await doAction({ type: 'medicate', key: v.target_key });
        else await doAction({ type: 'custom_med', label: v.label, prescription: v.prescription ?? HARMLESS });
        break;
      case 'surgery': {
        if (g.apLeft < 2) {
          pushMsg('nurse', '🧑‍⚕️ 护士:医生,手术需要 2 个行动点,这回合不够了。');
          return;
        }
        const label = v.target_key
          ? csRef.current.surgeries.find((x) => x.key === v.target_key)?.label ?? v.label
          : v.label;
        setPendingSurgery(
          v.target_key ? { key: v.target_key, label } : { label, prescription: v.prescription ?? HARMLESS }
        );
        break;
      }
      default:
        await chatWithPatient(); // other 也不用写死台词:患者听不懂会自己表达
    }
  };

  const callExpert = async () => {
    const g = gameRef.current;
    if (!g || busy || g.expertCallsLeft <= 0) return;
    sfx.expert();
    setStreaming(true);
    setDoctorAt('phone');
    const id = pushMsg('expert', '📞 正在连线专家…', false);
    const hint = await getExpertHint(csRef.current, g);
    setGame(recordExpertCall(g, hint));
    setMessages((m) => m.map((msg) => (msg.id === id ? { ...msg, text: `🎓 专家:${hint}`, done: true } : msg)));
    showToast('expert', `🎓 专家:${hint}`);
    setDoctorAt('desk');
    setStreaming(false);
  };

  const runEndTurn = useCallback(async () => {
    const g = gameRef.current;
    if (!g) return;
    sfx.turn();
    setGuidePalpate(false);
    setTempBed(false);
    setDoctorAt('desk');
    setTransition(true);
    await sleep(1400);
    const { state, events } = endTurn(csRef.current, g);
    setGame(state);
    processEvents(events);
    setTransition(false);
    if (state.phase === 'dead' || state.phase === 'cured') return; // 终局由 effect 统一弹出
    // 把本回合发生的事喂给患者,让回合末反应与操作强相关(也防复读)
    const recentEvents = state.timeline
      .filter((t) => t.turn === g.turn && t.detail !== '回合结束')
      .map((t) => `${t.detail}(${t.result})`);
    if (state.activeEffects.length) {
      recentEvents.push(
        `当前持续影响:${state.activeEffects.map((e) => `${e.label} ${e.rateDelta > 0 ? '+' : ''}${e.rateDelta}/回合`).join('、')}`
      );
    }
    recentEvents.push(`身体状态 ${g.hp}→${state.hp}(${state.hp < g.hp ? '在恶化' : '在好转'})`);
    await streamPatient({ kind: 'turn_end', recentEvents }, state);
  }, [streamPatient]);

  // 终局判定 + 行动点耗尽自动结束回合(鉴别模式终局后停摆)
  useEffect(() => {
    if (!game || ended || identEnded || streaming || transition) return;
    if (game.phase === 'dead' || game.phase === 'cured') {
      const t = setTimeout(() => setEnded(game.phase as 'dead' | 'cured'), 800);
      return () => clearTimeout(t);
    }
    if (game.apLeft === 0) {
      const t = setTimeout(() => void runEndTurn(), 900);
      return () => clearTimeout(t);
    }
  }, [game, ended, identEnded, streaming, transition, runEndTurn]);

  // 游戏结束 → 调用评估 Agent 复盘(一局只调一次)
  useEffect(() => {
    if (!ended || evalResult) return;
    const g = gameRef.current;
    if (!g) return;
    let cancelled = false;
    void evaluateGame(csRef.current, g, ended).then((r) => {
      if (!cancelled) setEvalResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [ended, evalResult]);

  // ===== 场景弹层的提交通道:提交即关弹层,后续反馈以场景气泡出现 =====
  const openPop = (p: 'talk' | 'orders' | 'cabinet' | 'surgery') => {
    setCmdInput('');
    setPopup(p);
  };

  const submitTalk = () => {
    const text = askInput.trim();
    if (!text) return;
    setAskInput('');
    setPopup(null);
    void doCommand(text);
  };

  const submitPop = (panel: Exclude<PanelHint, null>) => {
    const text = cmdInput.trim();
    if (!text) return;
    setCmdInput('');
    setPopup(null);
    void doCommand(text, panel);
  };

  const popRow = (panel: Exclude<PanelHint, null>, placeholder: string) =>
    game && (
      <div className="ask-row panel-cmd">
        <input
          value={cmdInput}
          onChange={(e) => setCmdInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && submitPop(panel)}
          placeholder={placeholder}
          disabled={busy || game.apLeft < 1}
        />
        <button className="primary" disabled={busy || game.apLeft < 1} onClick={() => submitPop(panel)}>
          执行
        </button>
      </div>
    );

  if (!game) {
    const generatingAny = generatingCase || generatingCustomCase || generatingIdent;
    return (
      <div className="start-screen">
        <h1>诊断模拟器</h1>
        <p className="sub">状态机管数值 · LLM 管表演({llmEnabled ? '真实 LLM 模式' : 'Mock 剧本模式'})</p>
        <div className="case-brief start-panel">
          <div className="start-title">急诊呼叫</div>
          <div className="start-tabs">
            <button className={`start-tab ${startMode === 'builtin' ? 'on' : ''}`} onClick={() => setStartMode('builtin')}>
              预设病例
            </button>
            <button className={`start-tab ${startMode === 'generated' ? 'on' : ''}`} onClick={() => setStartMode('generated')}>
              AI 生成
            </button>
            <button className={`start-tab ${startMode === 'custom' ? 'on' : ''}`} onClick={() => setStartMode('custom')}>
              自定义患者
            </button>
            <button className={`start-tab ${startMode === 'ident' ? 'on' : ''}`} onClick={() => setStartMode('ident')}>
              鉴别接诊
            </button>
          </div>

          {startMode === 'builtin' && (
            <div className="case-btns">
              {CASES.map(({ card, brief }) => (
                <button key={card.caseId} className="case-btn" disabled={generatingAny} onClick={() => void startGame(card)}>
                  <b>
                    {card.patient.name} · {card.patient.age}岁 · {card.patient.gender}
                  </b>
                  <span>{brief}</span>
                </button>
              ))}
            </div>
          )}

          {startMode === 'generated' && (
            <div className="case-builder">
              <div className="difficulty-list">
                {CASE_DIFFICULTIES.map((d) => (
                  <button
                    key={d.key}
                    className={`difficulty-option ${genDifficulty === d.key ? 'on' : ''}`}
                    disabled={generatingAny}
                    onClick={() => setGenDifficulty(d.key)}
                  >
                    <b>{d.label}</b>
                    <span>{d.desc}</span>
                  </button>
                ))}
              </div>
              <div className="group-label">科室(选"随机"则由系统抽签)</div>
              <div className="chips">
                {['随机', ...CASE_DEPARTMENTS].map((d) => (
                  <button
                    key={d}
                    className={`chip ${genDept === d ? 'on' : ''}`}
                    disabled={generatingAny}
                    onClick={() => setGenDept(d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <button className="primary start-action" disabled={!llmEnabled || generatingAny} onClick={() => void runGenerateCase()}>
                {generatingCase ? generationMessage || '生成中...' : llmEnabled ? '生成病例' : '需要配置 LLM key'}
              </button>
              {generatedCase && (
                <div className="case-preview">
                  <b>待接诊患者</b>
                  <pre>{summarizeCaseIntake(generatedCase)}</pre>
                  <button className="primary" onClick={() => void startGame(generatedCase)}>
                    开始接诊
                  </button>
                </div>
              )}
            </div>
          )}

          {startMode === 'custom' && (
            <div className="case-builder">
              <div className="custom-form">
                <label>
                  姓名
                  <input value={customName} onChange={(e) => setCustomName(e.target.value)} disabled={generatingAny} />
                </label>
                <label>
                  性别
                  <input value={customGender} onChange={(e) => setCustomGender(e.target.value)} disabled={generatingAny} />
                </label>
                <label>
                  年龄
                  <input value={customAge} onChange={(e) => setCustomAge(e.target.value)} disabled={generatingAny} inputMode="numeric" />
                </label>
                <label>
                  人格
                  <textarea value={customPersonality} onChange={(e) => setCustomPersonality(e.target.value)} disabled={generatingAny} />
                </label>
                <label>
                  疾病
                  <input value={customDisease} onChange={(e) => setCustomDisease(e.target.value)} disabled={generatingAny} />
                </label>
              </div>
              <button className="primary start-action" disabled={!llmEnabled || generatingAny} onClick={() => void runGenerateCustomCase()}>
                {generatingCustomCase ? generationMessage || '生成中...' : llmEnabled ? '生成自定义病例' : '需要配置 LLM key'}
              </button>
              {customGeneratedCase && (
                <div className="case-preview">
                  <b>待接诊患者</b>
                  <pre>{summarizeCaseIntake(customGeneratedCase)}</pre>
                  <button className="primary" onClick={() => void startGame(customGeneratedCase)}>
                    开始接诊
                  </button>
                </div>
              )}
            </div>
          )}

          {startMode === 'ident' && (
            <div className="case-builder">
              <div className="group-label">对面可能是真急症,也可能是影帝——真假各半,开局抽签,谁都不知道。</div>
              <div className="rule-hint">
                本模式隐藏"病情 HP"数值:只能靠问诊矛盾、查体不符、化验结果和病程变化来判断真假。
                随时可点患者信息栏的 📝 签发诊断书:「收治入院」继续救治,或「判定诈病」终止接诊。
                把真病人赶出去是重大事故;被影帝骗到最后,也自有代价。
              </div>
              <div className="group-label">科室(选"随机"则由系统抽签;真假都会顶着该科的主诉出现)</div>
              <div className="chips">
                {['随机', ...IDENT_DEPARTMENTS].map((d) => (
                  <button
                    key={d}
                    className={`chip ${identDept === d ? 'on' : ''}`}
                    disabled={generatingAny}
                    onClick={() => setIdentDept(d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
              <button
                className="primary start-action"
                disabled={!llmEnabled || generatingAny}
                onClick={() => void runStartIdent()}
              >
                {generatingIdent ? generationMessage || '接诊准备中...' : llmEnabled ? '开始接诊' : '需要配置 LLM key'}
              </button>
            </div>
          )}

          {!!caseErrors.length && (
            <div className="case-errors">
              {caseErrors.slice(0, 4).map((err) => (
                <div key={err}>{err}</div>
              ))}
            </div>
          )}

          <div className="rule-hint">每回合 2 行动点:问诊/检查/用药 1 点,手术 2 点。找出病因,正确处置。</div>
        </div>
      </div>
    );
  }

  const critical = game.phase === 'critical';
  const hpPct = (game.hp / game.hpMax) * 100;
  // 最新一条患者发言 → 舞台上的漫画气泡(流式打字也实时跟进)
  let stageBubble: { text: string; done: boolean } | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'patient') {
      stageBubble = { text: messages[i].text, done: messages[i].done };
      break;
    }
  }

  // 病人位置推导:生理否决 > 显式医嘱 > 默认坐凳
  const bedBound = game.phase !== 'active' || game.hp < 50;
  const loc: 'stool' | 'bed' = bedBound || tempBed || locOrder === 'bed' ? 'bed' : 'stool';
  locRef.current = loc;

  // 场景热区:身体 zone 来自病例卡,墙面道具开对应弹层
  const chestDef = cs.exams.find((e) => e.zone === 'chest');
  const abdDef = cs.exams.find((e) => e.zone === 'abdomen');
  const stageZones: StageZones = {
    enabled: !busy && !ended && game.apLeft >= 1 && game.phase !== 'dead',
    clockEnabled: !busy && !ended,
    phoneEnabled: !busy && !ended && game.expertCallsLeft > 0,
    expertLeft: game.expertCallsLeft,
    onBook: () => setDrawer((d) => !d),
    onBedMove: loc === 'stool' ? () => void orderMove('bed') : undefined,
    onStoolMove: loc === 'bed' && !bedBound ? () => void orderMove('stool') : undefined,
    onOrders: () => openPop('orders'),
    onCabinet: () => openPop('cabinet'),
    onSurgery: () => openPop('surgery'),
    onClock: () => {
      setPopup(null);
      void runEndTurn();
    },
    onPhone: () => {
      setPopup(null);
      void callExpert();
    },
    onHead: () => {
      openPop('talk');
      setTimeout(() => askInputRef.current?.focus(), 0);
    },
    chest: chestDef && {
      label: `${chestDef.label} · 1点`,
      onClick: () => void doAction({ type: 'exam', key: chestDef.key }),
    },
    abdomen: abdDef && {
      label: `${abdDef.label} · 1点`,
      onPalpate: () => {
        setGuidePalpate(false);
        void withBed(abdDef.onBed, async () => {
          await doAction({ type: 'exam', key: abdDef.key });
          // 松手瞬间的即时反应:把触诊事实喂给患者 LLM,疼不疼由它演
          const g = gameRef.current;
          const t = g?.timeline[g.timeline.length - 1];
          if (g && g.phase !== 'dead' && t?.action === 'exam') {
            await streamPatient({ kind: 'op_result', recentEvents: [`医生徒手按压查体:${t.detail} → ${t.result}`] }, g);
          }
        }).then(() => setTempBed(false)); // 引导时垫的"临时上床"做完即释放(生理允许就回凳)
      },
    },
  };

  // ===== 场景弹层 + 短暂气泡 + 病历本按钮(注入舞台) =====
  const stageOverlay = (
    <>
      {popup === 'talk' && !ended && (
        <div className="scene-pop pop-talk">
          <div className="pop-title">
            🗣 对话(问病情 1 点 · 寒暄免费)
            <button className="pop-x" onClick={() => setPopup(null)}>✕</button>
          </div>
          <div className="chips">
            {chips.map((q) => (
              <button
                key={q}
                className="chip"
                disabled={busy || game.apLeft < 1}
                onClick={() => {
                  setPopup(null);
                  void doCommand(q);
                }}
              >
                {q}
              </button>
            ))}
          </div>
          <div className="ask-row">
            <input
              ref={askInputRef}
              value={askInput}
              onChange={(e) => setAskInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && submitTalk()}
              placeholder="问他,或直接下医嘱:什么时候开始的? / 查个血常规 / 直接安排手术…"
              disabled={busy || game.apLeft < 1}
            />
            <button className="primary" disabled={busy || game.apLeft < 1} onClick={submitTalk}>
              说
            </button>
          </div>
        </div>
      )}

      {popup === 'orders' && !ended && (
        <div className="scene-pop pop-orders">
          <div className="pop-title">
            📋 检查申请单 · 每项1点
            <button className="pop-x" onClick={() => setPopup(null)}>✕</button>
          </div>
          <div className="grid-list">
            <div className="group-label">查体</div>
            {cs.exams.map((e) => (
              <button
                key={e.key}
                className="item"
                disabled={busy || game.apLeft < 1}
                onClick={() => {
                  if (e.zone === 'abdomen') {
                    void startGuidedPalpation(); // 触诊类:开单后要亲手按
                  } else {
                    setPopup(null);
                    void withBed(e.onBed, () => doAction({ type: 'exam', key: e.key }));
                  }
                }}
              >
                {e.label}
                {game.doneExams.includes(e.key) && <span className="done-mark">✓已做</span>}
              </button>
            ))}
            <div className="group-label">化验/影像</div>
            {cs.labs.map((l) => (
              <button
                key={l.key}
                className="item"
                disabled={busy || game.apLeft < 1}
                onClick={() => {
                  setPopup(null);
                  void withBed(l.onBed, () => doAction({ type: 'lab', key: l.key }));
                }}
              >
                {l.label}
                {game.doneLabs.includes(l.key) && <span className="done-mark">✓已做</span>}
              </button>
            ))}
            {popRow('exam', '单子上没有?直接写:腹部CT / 肠镜 / 腰穿…')}
          </div>
        </div>
      )}

      {popup === 'cabinet' && !ended && (
        <div className="scene-pop pop-cabinet">
          <div className="pop-title">
            💊 药柜 · 每次1点
            <button className="pop-x" onClick={() => setPopup(null)}>✕</button>
          </div>
          <div className="grid-list">
            {cs.meds.map((m) => (
              <button
                key={m.key}
                className="item"
                disabled={busy || game.apLeft < 1}
                onClick={() => {
                  setPopup(null);
                  void doAction({ type: 'medicate', key: m.key });
                }}
              >
                {m.label}
              </button>
            ))}
            {popRow('med', '处方笺:药名+剂量,如 头孢曲松2g静滴…')}
          </div>
        </div>
      )}

      {popup === 'surgery' && !ended && (
        <div className="scene-pop pop-surgery">
          <div className="pop-title">
            🚪 手术室 · 2点
            <button className="pop-x" onClick={() => setPopup(null)}>✕</button>
          </div>
          <div className="grid-list">
            {cs.surgeries.map((sg) => (
              <button
                key={sg.key}
                className="item danger"
                disabled={busy || game.apLeft < 2}
                onClick={() => {
                  setPopup(null);
                  setPendingSurgery({ key: sg.key, label: sg.label });
                }}
              >
                {sg.label}
              </button>
            ))}
            {popRow('surgery', '自定义术式,如:剖腹探查 / 截肢…')}
            {game.apLeft < 2 && <div className="hint">手术需要 2 行动点,这回合不够了</div>}
          </div>
        </div>
      )}

      {toast &&
        (toast.role === 'doctor' ? (
          // 医生说的话从医生头顶冒出
          <div className="stage-bubble doc-b" style={{ left: DOC_LEFT[doctorAt] }}>
            {toast.text}
          </div>
        ) : (
          <div className={`stage-toast t-${toast.role}`}>{toast.text}</div>
        ))}
    </>
  );

  return (
    <div className={`app ${critical ? 'critical' : ''}`}>
      {/* ===== 左列:患者区 + 操作区 ===== */}
      <div className="left-col">
        <div className="patient-area">
          <div className="patient-head">
            <div className="patient-info">
              <div className="patient-name">
                {cs.patient.name} · {cs.patient.age}岁 · {cs.patient.gender}
              </div>
              <div className={`patient-phase phase-${game.phase}`}>{PHASE_LABEL[game.phase]}</div>
            </div>
            {identMode && !ended && !identEnded && (
              <button className="mute-btn" title="签发诊断书:收治入院 / 判定诈病" onClick={() => setVerdictOpen(true)}>
                📝
              </button>
            )}
            <button className="mute-btn" title="2D/3D 渲染切换" onClick={() => setUse3d((v) => !v)}>
              {use3d ? '🧊 3D' : '🎨 2D'}
            </button>
            <button className="mute-btn" title="静音开关" onClick={() => setMuted((m) => !m)}>
              {muted ? '🔇' : '🔊'}
            </button>
          </div>
          {use3d ? (
            <StageBoundary
              fallback={
                <PatientStage
                  card={cs}
                  game={game}
                  bubble={stageBubble}
                  loc={loc}
                  doctorAt={doctorAt}
                  guide={guidePalpate}
                  zones={stageZones}
                  overlay={stageOverlay}
                />
              }
            >
              <PatientStage3D
                card={cs}
                game={game}
                bubble={stageBubble}
                loc={loc}
                doctorAt={doctorAt}
                guide={guidePalpate}
                zones={stageZones}
                overlay={stageOverlay}
              />
            </StageBoundary>
          ) : (
            <PatientStage
              card={cs}
              game={game}
              bubble={stageBubble}
              loc={loc}
              doctorAt={doctorAt}
              guide={guidePalpate}
              zones={stageZones}
              overlay={stageOverlay}
            />
          )}
        </div>
      </div>

      {/* ===== 右列:监护仪 + 病历夹 ===== */}
      <div className="right-col">
        <div className={`monitor ${critical ? 'alarm' : ''}`}>
          <div className="monitor-title">
            <span>MONITOR</span>
            <span className="turn-badge">第 {game.turn} 回合</span>
          </div>
          <div className="vitals">
            <div className="vital hr">
              <label>HR</label>
              <b key={`hr${game.vitals.hr}`}>{game.vitals.hr}</b>
              <small>bpm</small>
            </div>
            <div className="vital bp">
              <label>BP</label>
              <b key={`bp${game.vitals.bpSys}`}>
                {game.vitals.bpSys}/{game.vitals.bpDia}
              </b>
              <small>mmHg</small>
            </div>
            <div className="vital temp">
              <label>TEMP</label>
              <b key={`t${game.vitals.temp}`}>{game.vitals.temp.toFixed(1)}</b>
              <small>°C</small>
            </div>
            <div className="vital spo2">
              <label>SpO₂</label>
              <b key={`s${game.vitals.spo2}`}>{game.vitals.spo2}</b>
              <small>%</small>
            </div>
          </div>
          {/* 鉴别模式隐藏上帝视角的 HP:真假只能靠证据判断(数值照常运转,仅不展示) */}
          {!identMode && (
            <div className="hp-row">
              <label>病情 HP</label>
              <div className="hp-bar">
                <div
                  className={`hp-fill ${hpPct <= 30 ? 'low' : hpPct <= 55 ? 'mid' : ''}`}
                  style={{ width: `${hpPct}%` }}
                />
              </div>
              <span className="hp-num">{game.hp}</span>
            </div>
          )}
          <div className="ap-row">
            <label>行动点</label>
            <span className="ap-dots">
              {Array.from({ length: 2 }).map((_, i) => (
                <i key={i} className={i < game.apLeft ? 'on' : ''}>
                  ●
                </i>
              ))}
            </span>
          </div>
          {game.activeEffects.length > 0 && (
            <div className="effects">
              {game.activeEffects.map((e) => (
                <span key={e.id} className={`effect ${e.rateDelta < 0 ? 'bad' : 'good'}`}>
                  {e.label}
                  {e.remaining !== null ? `·剩${e.remaining}回合` : ''}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="folder">
          <div className="folder-title">📋 病历夹</div>
          {game.revealed.length > 0 && (
            <div className="clues">
              {game.revealed.map((k) => {
                const sym = [...cs.hiddenAsk, ...cs.hiddenExam, ...cs.hiddenLab].find((h) => h.key === k);
                return (
                  <div key={k} className="clue">
                    🔍 {sym?.desc}
                  </div>
                );
              })}
            </div>
          )}
          <div className="cards">
            {cards.map((c) => (
              <div key={c.id} className={`result-card ${flashCard === c.id ? 'flash' : ''}`}>
                <div className="card-head">
                  <span>{c.title}</span>
                  <span className="card-turn">第{c.turn}回合</span>
                </div>
                {c.rows.map((r) => (
                  <div key={r.name} className={`card-row ${r.abnormal ? 'abnormal' : ''}`}>
                    <span className="row-name">{r.name}</span>
                    <span className="row-val">
                      {r.value}
                      {r.abnormal ? ' ⚠' : ''}
                    </span>
                    {r.ref && <span className="ref">参考 {r.ref}</span>}
                  </div>
                ))}
                {c.note && <div className="card-note">{c.note}</div>}
              </div>
            ))}
            {cards.length === 0 && <div className="empty">检查/化验结果将以卡片形式在此堆叠</div>}
          </div>
        </div>
      </div>

      {/* ===== 病历本抽屉:完整对话与事件记录 ===== */}
      {drawer && (
        <div className="drawer">
          <div className="drawer-head">
            📖 病历本
            <button className="pop-x" onClick={() => setDrawer(false)}>✕</button>
          </div>
          <div className="chat" ref={chatRef}>
            {messages.map((m) => (
              <div key={m.id} className={`bubble ${m.role}`}>
                {m.text}
                {!m.done && <span className="cursor">▌</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== 覆盖层 ===== */}
      {transition && (
        <div className="overlay transition">
          <div className="transition-text">⏳ 回合结束 · 病情演化中…</div>
        </div>
      )}

      {pendingSurgery && (
        <div className="overlay">
          <div className="dialog">
            <h3>⚠ 确认手术</h3>
            <p>即将执行「{pendingSurgery.label}」,消耗 2 行动点,后果不可逆。</p>
            <div className="dialog-btns">
              <button className="ghost" onClick={() => setPendingSurgery(null)}>
                再想想
              </button>
              <button
                className="primary danger-btn"
                onClick={() => {
                  const p = pendingSurgery;
                  setPendingSurgery(null);
                  if (p.key) void doAction({ type: 'surgery', key: p.key });
                  else
                    void doAction({
                      type: 'custom_surgery',
                      label: p.label,
                      prescription: p.prescription ?? HARMLESS,
                    });
                }}
              >
                上台!
              </button>
            </div>
          </div>
        </div>
      )}

      {verdictOpen && !ended && !identEnded && (
        <VerdictDialog
          tells={game.revealed.length}
          busy={busy}
          onClose={() => setVerdictOpen(false)}
          onAdmit={() => void signVerdict('admit')}
          onExpose={() => void signVerdict('expose')}
        />
      )}

      {identEnded && (
        <IdentEndPanel
          ending={identEnded}
          card={cs}
          game={game}
          review={identReview}
          onBack={() => setGame(null)}
        />
      )}

      {ended && (
        <div className="overlay">
          <div className={`dialog end ${ended}`}>
            <h2>{ended === 'cured' ? '🎉 治愈出院' : '🕯 抢救无效'}</h2>
            <p className="end-sub">
              {ended === 'cured'
                ? `${cs.patient.name}康复出院。真实诊断:${cs.trueDiagnosis}`
                : `${cs.patient.name}于第 ${game.turn} 回合死亡。真实诊断:${cs.trueDiagnosis}`}
            </p>
            {!evalResult ? (
              <div className="eval-loading">🩺 主任医师正在复盘本局操作…</div>
            ) : (
              <div className="eval-report">
                <div className="eval-head">
                  <div className={`score ${evalResult.score >= 60 ? 'pass' : 'fail'}`}>
                    <b>{evalResult.score}</b>
                    <small>分</small>
                  </div>
                  <div className="eval-summary">{evalResult.outcome_summary}</div>
                </div>
                <div className="eval-sec">
                  <div className="eval-sec-title">🔗 结局溯源</div>
                  {evalResult.root_cause.map((r, i) => (
                    <div key={i} className="eval-row">
                      <span className="tl-turn">T{r.turn}</span>
                      <span>{r.text}</span>
                    </div>
                  ))}
                </div>
                {evalResult.rubric_results.length > 0 && (
                  <div className="eval-sec">
                    <div className="eval-sec-title">📋 评分表(达标=1 · 部分=0.5 · 按权重加权)</div>
                    {[...new Set(evalResult.rubric_results.map((r) => r.domain))].map((domain) => (
                      <div key={domain} className="rubric-group">
                        <div className="rubric-domain">{domain}</div>
                        {evalResult.rubric_results
                          .filter((r) => r.domain === domain)
                          .map((r) => (
                            <div key={r.id} className={`rubric-row ${r.met}`}>
                              <span className="rubric-mark">
                                {r.met === 'met' ? '✓' : r.met === 'partial' ? '◐' : '✗'}
                              </span>
                              <span className="rubric-body">
                                <span className="rubric-label">
                                  {r.label}
                                  <i className="rubric-meta">权重{r.weight}</i>
                                </span>
                                <span className="rubric-evidence">{r.evidence}</span>
                              </span>
                            </div>
                          ))}
                      </div>
                    ))}
                  </div>
                )}
                <div className="eval-sec">
                  <div className="eval-sec-title">💡 建议</div>
                  {evalResult.suggestions.map((p, i) => (
                    <div key={i} className="eval-row">
                      <span>{p}</span>
                    </div>
                  ))}
                </div>
                {evalResult.source === 'rule' && (
                  <p className="hint">(LLM 不可用,仅按结局给出基础分,未做逐条判定)</p>
                )}
              </div>
            )}
            <details className="tl-details">
              <summary>完整操作时间线</summary>
              <div className="timeline-recap">
                {game.timeline.map((t, i) => (
                  <div key={i} className="tl-row">
                    <span className="tl-turn">T{t.turn}</span>
                    <span className="tl-detail">{t.detail}</span>
                    <span className="tl-result">{t.result}</span>
                  </div>
                ))}
              </div>
            </details>
            <button className="primary big" onClick={() => setGame(null)}>
              返回选择病例
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
