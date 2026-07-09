// 鉴别接诊模式的两块 UI:诊断书弹层 + 终局面板。纯展示组件,复用 App.css 现有样式类。
import type { CaseCard, GameState } from '../game/types';
import type { IdentEnding, IdentReview } from '../game/deception';

export function VerdictDialog(props: {
  tells: number;
  busy: boolean;
  onAdmit: () => void;
  onExpose: () => void;
  onClose: () => void;
}) {
  return (
    <div className="overlay">
      <div className="dialog">
        <h3>📝 签发诊断书</h3>
        <p>
          已掌握关键发现 <b>{props.tells}</b> 条。
          <br />
          「收治入院」= 认定真病,继续救治(之后仍可改判);
          <br />
          「判定诈病」= 终止接诊,<b>立即终局、不可撤回</b>——判错真病人后果自负。
        </p>
        <div className="dialog-btns">
          <button className="ghost" onClick={props.onClose}>
            再观察观察
          </button>
          <button className="primary" disabled={props.busy} onClick={props.onAdmit}>
            收治入院
          </button>
          <button className="primary danger-btn" disabled={props.busy} onClick={props.onExpose}>
            判定诈病
          </button>
        </div>
      </div>
    </div>
  );
}

const ENDING_META: Record<IdentEnding, { title: string; tone: 'cured' | 'dead' }> = {
  exposed: { title: '🕵️ 识破!', tone: 'cured' },
  wrong_expose: { title: '⚖️ 误判事故', tone: 'dead' },
  duped_exit: { title: '🎭 他得逞了', tone: 'dead' },
  gave_up: { title: '🚪 他溜了', tone: 'cured' },
};

function endingSub(ending: IdentEnding, card: CaseCard): string {
  const d = card.deception;
  switch (ending) {
    case 'exposed':
      return `${card.patient.name}承认了一切。动机:${d?.motive ?? '不详'};他声称的「${d?.claimedDisease ?? ''}」纯属表演。`;
    case 'wrong_expose':
      return `${card.patient.name}真的患有「${card.trueDiagnosis}」。被判定诈病赶出急诊后,他的病情在院外持续恶化——这是一起严重医疗差错。`;
    case 'duped_exit':
      return `${card.patient.name}拿到想要的东西后离开了。动机:${d?.motive ?? '不详'};目的:${d?.goal ?? '不详'}。你自始至终没有识破。`;
    case 'gave_up':
      return `${card.patient.name}觉得演不下去,借口离开了急诊。事后证实:${d?.motive ?? '诈病'}。你没被骗到,但也没能当面识破。`;
  }
}

export function IdentEndPanel(props: {
  ending: IdentEnding;
  card: CaseCard;
  game: GameState;
  review: IdentReview | null;
  onBack: () => void;
}) {
  const meta = ENDING_META[props.ending];
  return (
    <div className="overlay">
      <div className={`dialog end ${meta.tone}`}>
        <h2>{meta.title}</h2>
        <p className="end-sub">{endingSub(props.ending, props.card)}</p>
        {!props.review ? (
          <div className="eval-loading">🩺 主任医师正在复盘本局鉴别…</div>
        ) : (
          <div className="eval-report">
            <div className="eval-head">
              <div className={`score ${props.review.score >= 60 ? 'pass' : 'fail'}`}>
                <b>{props.review.score}</b>
                <small>分</small>
              </div>
              <div className="eval-summary">{props.review.summary}</div>
            </div>
            {props.review.points.length > 0 && (
              <div className="eval-sec">
                <div className="eval-sec-title">🔗 关键复盘</div>
                {props.review.points.map((p, i) => (
                  <div key={i} className="eval-row">
                    <span>{p}</span>
                  </div>
                ))}
              </div>
            )}
            {props.review.suggestions.length > 0 && (
              <div className="eval-sec">
                <div className="eval-sec-title">💡 建议</div>
                {props.review.suggestions.map((p, i) => (
                  <div key={i} className="eval-row">
                    <span>{p}</span>
                  </div>
                ))}
              </div>
            )}
            {props.review.source === 'rule' && <p className="hint">(LLM 不可用,仅按结局给出基础分)</p>}
          </div>
        )}
        <details className="tl-details">
          <summary>完整操作时间线</summary>
          <div className="timeline-recap">
            {props.game.timeline.map((t, i) => (
              <div key={i} className="tl-row">
                <span className="tl-turn">T{t.turn}</span>
                <span className="tl-detail">{t.detail}</span>
                <span className="tl-result">{t.result}</span>
              </div>
            ))}
          </div>
        </details>
        <button className="primary big" onClick={props.onBack}>
          返回选择病例
        </button>
      </div>
    </div>
  );
}
