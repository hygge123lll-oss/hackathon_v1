// 3D 诊室舞台(react-three-fiber)—— 与 PatientStage 同一套 props 接口,渲染层可切换。
// 人物:Quaternius CC0 骨骼动画角色(医生/老爷子/姑娘),坐诊/走位/躺床/挨按/治愈欢呼全是真动画。
// 场景:Toon 三段色阶 + 描边 + 圆角几何 + 接触软阴影。逻辑零判定,交互回调全部转发回 App。
import * as THREE from 'three';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows, Html, Outlines, RoundedBox, useAnimations, useGLTF } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SkeletonUtils } from 'three-stdlib';
import type { Group, Mesh, PointLight } from 'three';
import type { CaseCard, GameState } from '../game/types';
import type { StageZones } from './PatientStage';

interface Bubble {
  text: string;
  done: boolean;
}
interface Props {
  card: CaseCard;
  game: GameState;
  bubble: Bubble | null;
  loc: 'stool' | 'bed';
  doctorAt: 'desk' | 'bed' | 'phone';
  guide?: boolean;
  zones?: StageZones;
  overlay?: ReactNode;
}

const PALPATE_MS = 550;
const CHAR_SCALE = 0.78;

const MODELS = {
  doctor: '/models/doctor.gltf',
  old: '/models/patient_old.gltf',
  male: '/models/patient_bald.gltf',
  female: '/models/patient_female.gltf',
};
useGLTF.preload(MODELS.doctor);
useGLTF.preload(MODELS.old);
useGLTF.preload(MODELS.male);
useGLTF.preload(MODELS.female);

// 毛绒粉彩(与 CSS 变量同源的硬编码副本,WebGL 里用不了 var())
const C = {
  line: '#2B1E16',
  cream2: '#F4E7CF',
  paper: '#FBF3E4',
  floor: '#F0E0C2',
  mint: '#BFE8CF',
  sky: '#BFE0F5',
  butter: '#FFE9A8',
  rose: '#F4A0B2',
  roseDeep: '#E0526F',
  lav: '#D9CBF2',
  wood: '#E9D9B8',
  white: '#FFFDF8',
};

// Toon 渐变贴图(三段色阶),全场景共用一份
let _grad: THREE.DataTexture | null = null;
function grad(): THREE.DataTexture {
  if (!_grad) {
    _grad = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat);
    _grad.minFilter = THREE.NearestFilter;
    _grad.magFilter = THREE.NearestFilter;
    _grad.needsUpdate = true;
  }
  return _grad;
}

/** 卡通材质 + 描边(挂在 mesh 内) */
function Skin({ color, outline = 0.02 }: { color: string; outline?: number }) {
  return (
    <>
      <meshToonMaterial color={color} gradientMap={grad()} />
      {outline > 0 && <Outlines thickness={outline} color={C.line} />}
    </>
  );
}

/** 圆角卡通盒子 */
function TBox({
  args,
  color,
  radius = 0.05,
  outline = 0.02,
  ...rest
}: {
  args: [number, number, number];
  color: string;
  radius?: number;
  outline?: number;
  position?: [number, number, number];
  rotation?: [number, number, number];
}) {
  return (
    <RoundedBox args={args} radius={Math.min(radius, Math.min(...args) / 2.01)} smoothness={3} {...rest}>
      <Skin color={color} outline={outline} />
    </RoundedBox>
  );
}

type Mood = 'mild' | 'strained' | 'agony' | 'calm' | 'happy' | 'dead';
function moodOf(g: GameState): Mood {
  if (g.phase === 'dead') return 'dead';
  if (g.phase === 'cured') return 'happy';
  if (g.phase === 'recovering') return 'calm';
  if (g.phase === 'critical' || g.hp <= 30) return 'agony';
  if (g.hp < 55) return 'strained';
  return 'mild';
}
const MOOD_TAG: Record<Mood, string> = {
  mild: '😕',
  strained: '😖',
  agony: '😫',
  calm: '😌',
  happy: '🎉',
  dead: '',
};

/** 悬停提示牌(挂在 3D 坐标上的 HTML) */
function Chip({ text, warn = false, y = 0 }: { text: string; warn?: boolean; y?: number }) {
  return (
    <Html center position={[0, y, 0]} zIndexRange={[3, 3]} style={{ pointerEvents: 'none' }}>
      <div className={`chip3d ${warn ? 'warn' : ''}`}>{text}</div>
    </Html>
  );
}

/** 可点击热区:悬停高亮 + 提示牌 */
function Hot({
  position,
  size,
  shape = 'box',
  label,
  onClick,
  children,
}: {
  position: [number, number, number];
  size: [number, number, number] | number;
  shape?: 'box' | 'sphere';
  label: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const [hov, setHov] = useState(false);
  return (
    <group position={position}>
      <mesh
        onClick={(e) => {
          e.stopPropagation();
          onClick?.();
        }}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHov(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHov(false);
          document.body.style.cursor = 'default';
        }}
      >
        {shape === 'box' ? (
          <boxGeometry args={typeof size === 'number' ? [size, size, size] : size} />
        ) : (
          <sphereGeometry args={[typeof size === 'number' ? size : size[0], 16, 16]} />
        )}
        <meshBasicMaterial color={C.sky} transparent opacity={hov ? 0.25 : 0} depthWrite={false} />
      </mesh>
      {hov && <Chip text={label} y={typeof size === 'number' ? size + 0.25 : size[1] / 2 + 0.3} />}
      {children}
    </group>
  );
}

/** 骨骼动画角色:加载 GLTF,按 clip 播动画(once=定格在最后一帧) */
function Char({
  url,
  clip,
  once = false,
  freeze = false,
  scale = CHAR_SCALE,
  tag,
}: {
  url: string;
  clip: string;
  once?: boolean;
  /** 不播放过程,直接定格在动画最后一帧(淡入混合过渡) */
  freeze?: boolean;
  /** 体型(儿童患者缩小) */
  scale?: number;
  tag?: ReactNode;
}) {
  const group = useRef<Group>(null);
  const { scene, animations } = useGLTF(url);
  const cloned = useMemo(() => {
    const c = SkeletonUtils.clone(scene);
    // 资产出厂的 Skin 材质接近纯黑(baseColorFactor≈0.013),渲染出来像剪影,改成暖肤色
    c.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) {
        const mat = m as THREE.MeshStandardMaterial;
        if (mat?.name === 'Skin') mat.color.set('#F2BE94');
      }
    });
    return c;
  }, [scene]);
  const { actions } = useAnimations(animations, group);
  useEffect(() => {
    const a = actions[clip];
    if (!a) return;
    a.reset();
    if (once) {
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
    } else {
      a.setLoop(THREE.LoopRepeat, Infinity);
    }
    a.fadeIn(0.2).play();
    if (freeze) {
      // 跳到最后一帧定格(如躺姿:Death 动画的倒下过程不演,直接躺好)
      a.time = Math.max(0, a.getClip().duration - 0.001);
      a.paused = true;
    }
    return () => {
      a.fadeOut(0.2);
    };
  }, [actions, clip, once, freeze]);
  return (
    <group ref={group} scale={scale}>
      <primitive object={cloned} />
      {tag}
    </group>
  );
}

/** 医生:在锚位间真的走过去(Walk↔Idle 自动切换) */
function Doctor3D({ target, facing }: { target: [number, number, number]; facing: number }) {
  const ref = useRef<Group>(null);
  const [moving, setMoving] = useState(false);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    const dx = target[0] - g.position.x;
    const dz = target[2] - g.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.06) {
      const step = Math.min(dist, dt * 2.4);
      g.position.x += (dx / dist) * step;
      g.position.z += (dz / dist) * step;
      g.rotation.y = Math.atan2(dx, dz);
      if (!moving) setMoving(true);
    } else {
      if (moving) setMoving(false);
      const d = facing - g.rotation.y;
      g.rotation.y += Math.atan2(Math.sin(d), Math.cos(d)) * Math.min(1, dt * 6);
    }
  });
  return (
    <group ref={ref} position={[-0.5, 0, -1.2]}>
      <Char url={MODELS.doctor} clip={moving ? 'Walk' : 'Idle'} />
    </group>
  );
}

interface Pose {
  pos: [number, number, number];
  rotY: number;
  clip: string;
  once: boolean;
  /** 状态表情牌离脚底的高度(按姿势不同) */
  tagY: number;
  /** 表情牌横向偏移(躺姿时根节点在脚,牌要往头的方向挪) */
  tagX?: number;
  /** 绕身体长轴翻滚 180°(Death 动画终止帧是趴姿,翻成仰卧) */
  roll?: boolean;
  /** 不演动画过程,直接定格最后一帧(躺姿用,避免倒放翻转的鬼畜过程) */
  freeze?: boolean;
}

/** 病人:走向目标姿势点,到位后播姿势动画;危急时发抖 */
function PatientChar({ url, pose, shaking, scale, tag }: { url: string; pose: Pose; shaking: boolean; scale?: number; tag?: ReactNode }) {
  const ref = useRef<Group>(null);
  const [moving, setMoving] = useState(false);
  useFrame((_, dt) => {
    const g = ref.current;
    if (!g) return;
    const [tx, ty, tz] = pose.pos;
    const dx = tx - g.position.x;
    const dz = tz - g.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.08) {
      const step = Math.min(dist, dt * 2.0);
      g.position.x += (dx / dist) * step;
      g.position.z += (dz / dist) * step;
      g.position.y += (ty - g.position.y) * Math.min(1, dt * 3);
      g.rotation.y = Math.atan2(dx, dz);
      if (!moving) setMoving(true);
    } else {
      g.position.y += (ty - g.position.y) * Math.min(1, dt * 5);
      if (moving) setMoving(false);
      const d = pose.rotY - g.rotation.y;
      g.rotation.y += Math.atan2(Math.sin(d), Math.cos(d)) * Math.min(1, dt * 6);
      if (shaking) g.position.x = tx + Math.sin(performance.now() / 28) * 0.02;
      else g.position.x = tx;
    }
  });
  return (
    <group ref={ref} position={pose.pos}>
      <group rotation={[0, 0, pose.roll && !moving ? Math.PI : 0]}>
        <Char url={url} clip={moving ? 'Walk' : pose.clip} once={!moving && pose.once} freeze={!moving && pose.freeze} scale={scale} />
      </group>
      {/* 状态表情牌:挂在姿势对应的头顶高度,不随动画根骨骼漂移 */}
      {tag && <group position={[pose.tagX ?? 0, pose.tagY, 0]}>{tag}</group>}
    </group>
  );
}

/** 危急红光呼吸 */
function AlarmLight({ on }: { on: boolean }) {
  const ref = useRef<PointLight>(null);
  useFrame(({ clock }) => {
    if (ref.current) ref.current.intensity = on ? 2.2 + Math.sin(clock.elapsedTime * 5) * 1.6 : 0;
  });
  return <pointLight ref={ref} position={[0, 3.4, 1.5]} color="#FF5F7A" intensity={0} distance={16} />;
}

/** 引导触诊的脉动指示环 */
function GuideRing({ position }: { position: [number, number, number] }) {
  const ref = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    const m = ref.current;
    if (!m) return;
    const s = 1 + Math.sin(clock.elapsedTime * 4) * 0.15;
    m.scale.set(s, s, s);
  });
  return (
    <mesh ref={ref} position={position} rotation={[-Math.PI / 2, 0, 0]}>
      <torusGeometry args={[0.34, 0.05, 10, 32]} />
      <meshToonMaterial color={C.roseDeep} gradientMap={grad()} emissive={C.roseDeep} emissiveIntensity={0.55} />
    </mesh>
  );
}

export function PatientStage3D({ card, game, bubble, loc, doctorAt, guide, zones, overlay }: Props) {
  const [pressing, setPressing] = useState(false);
  const [pressHint, setPressHint] = useState(false);
  const pressAt = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const mood = moodOf(game);
  const bedSitting = loc === 'bed' && (game.phase === 'recovering' || game.phase === 'cured');
  const iv = game.activeEffects.some((e) => e.rateDelta > 0);
  const elderly = card.patient.age >= 45;
  const male = /男/.test(card.patient.gender);
  const child = card.patient.age < 14;
  // 按性别+年龄选模型;儿童用成人模型缩小(资产包无儿童模型)
  const patientModel = male ? (elderly ? MODELS.old : MODELS.male) : MODELS.female;
  const patientScale = child ? CHAR_SCALE * 0.62 : CHAR_SCALE;
  // 陪同家属(儿科/意识障碍病例):按称谓猜性别选模型,站在患者旁
  const guardian = card.patient.guardian;
  const guardianModel = guardian && /[妈母奶姥婆姐妻嫂姨女]/.test(guardian.relation) ? MODELS.female : MODELS.male;
  const guardianAt: [number, number, number] = loc === 'stool' ? [2.1, 0, 0.62] : [2.62, 0, 0.72];
  const guardianFacing = loc === 'stool' ? Math.atan2(1.38 - 2.1, 0 - 0.62) : Math.atan2(3.9 - 2.62, -0.2 - 0.72);
  const docAt = pressing ? 'bed' : doctorAt;
  const docTarget: Record<'desk' | 'bed' | 'phone', [number, number, number]> = {
    desk: [-0.5, 0, -1.2],
    bed: [2.5, 0, 0.95],
    phone: [0.35, 0, -1.3],
  };
  const docFacing: Record<'desk' | 'bed' | 'phone', number> = {
    desk: Math.atan2(1.9, 1.2), // 面向病人凳
    bed: Math.atan2(1.2, -0.95), // 面向床
    phone: Math.PI, // 面向墙
  };

  // 病人姿势(位置/朝向/动画),由 App 推导的 loc + phase 决定
  const pose: Pose =
    loc === 'stool'
      ? { pos: [1.38, 0.23, 0], rotY: -Math.PI / 2, clip: 'SitDown', once: true, tagY: 1.95 }
      : game.phase === 'cured'
        ? { pos: [2.6, 0, 0.9], rotY: 0.25, clip: 'Victory', once: false, tagY: 2.0 }
        : bedSitting
          ? { pos: [3.0, 0.85, 0.22], rotY: 0, clip: 'SitDown', once: true, tagY: 1.5 }
          : { pos: [4.8, 1.34, -0.2], rotY: -Math.PI / 2, clip: 'Death', once: true, tagY: 0.6, tagX: -1.0, roll: true, freeze: true };
  // 按压反应不切动画(RecieveHit 是站姿动画,躺/坐着的人会诡异地站起来):表情牌+台词已足够
  const effPose: Pose = pose;

  // 身体热区关键点(按姿势;儿童体型小,坐标另配)
  const spots = child
    ? loc === 'stool'
      ? { head: [1.5, 1.1, 0], chest: [1.45, 0.8, 0.1], belly: [1.42, 0.64, 0.12] }
      : bedSitting
        ? { head: [3.0, 1.62, 0.25], chest: [3.0, 1.32, 0.4], belly: [3.0, 1.2, 0.4] }
        : { head: [3.75, 1.22, -0.2], chest: [4.1, 1.25, -0.2], belly: [4.35, 1.25, -0.2] }
    : loc === 'stool'
      ? { head: [1.72, 1.68, 0], chest: [1.58, 1.16, 0.1], belly: [1.5, 0.88, 0.14] }
      : bedSitting
        ? { head: [3.0, 1.98, 0.25], chest: [3.0, 1.55, 0.45], belly: [3.0, 1.35, 0.45] }
        : { head: [2.35, 1.25, -0.2], chest: [2.9, 1.3, -0.2], belly: [3.3, 1.3, -0.2] };

  const endPress = (fire: boolean) => {
    if (!pressing) return;
    setPressing(false);
    if (!fire) return;
    if (Date.now() - pressAt.current >= PALPATE_MS) {
      zones?.abdomen?.onPalpate();
    } else {
      setPressHint(true);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setPressHint(false), 1600);
    }
  };

  const clockAngle = ((game.turn * 55) % 360) * (Math.PI / 180);
  const tagText = `${MOOD_TAG[mood]}${game.vitals.temp >= 37.7 && mood !== 'dead' ? '🌡' : ''}`;
  const patientTag = tagText ? (
    <Html center position={[0, 0, 0]} distanceFactor={7} zIndexRange={[2, 2]} style={{ pointerEvents: 'none' }}>
      <div className="face3d">{tagText}</div>
    </Html>
  ) : undefined;

  return (
    <div className={`stage stage3d phase-${game.phase}`}>
      <Canvas
        camera={{ position: [0.15, 3.8, 8.5], fov: 40 }}
        onCreated={({ camera }) => camera.lookAt(0.15, 0.85, 0)}
      >
        {/* ===== 灯光 ===== */}
        <ambientLight intensity={1.05} color="#FFF4E0" />
        <hemisphereLight args={['#FFF8E8', '#E4D2AE', 0.55]} />
        <directionalLight position={[4, 7, 5]} intensity={0.9} />
        <AlarmLight on={game.phase === 'critical'} />

        {/* ===== 房间 ===== */}
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 1]}>
          <planeGeometry args={[15, 10]} />
          <meshToonMaterial color={C.floor} gradientMap={grad()} />
        </mesh>
        <mesh position={[0, 2.7, -2.62]}>
          <boxGeometry args={[15, 5.4, 0.2]} />
          <meshToonMaterial color={C.paper} gradientMap={grad()} />
        </mesh>
        <TBox args={[15, 0.22, 0.08]} color={C.cream2} position={[0, 0.11, -2.5]} radius={0.03} outline={0.012} />
        <ContactShadows position={[0, 0.01, 0.8]} opacity={0.32} scale={17} blur={2.6} far={4.5} resolution={512} color={C.line} />

        {/* 窗户 + 窗帘 */}
        <TBox args={[1.9, 1.4, 0.1]} color={C.white} position={[3.7, 3, -2.5]} radius={0.06} />
        <mesh position={[3.7, 3, -2.43]}>
          <boxGeometry args={[1.6, 1.1, 0.04]} />
          <meshToonMaterial color="#D8EEFF" gradientMap={grad()} />
        </mesh>
        <TBox args={[0.32, 1.6, 0.12]} color={C.lav} position={[2.55, 3, -2.44]} radius={0.1} />

        {/* ===== 手术室门(左墙) ===== */}
        <group position={[-4.7, 0, -2.4]}>
          <TBox args={[1.74, 3.04, 0.18]} color={C.line} position={[0, 1.5, -0.02]} radius={0.04} outline={0} />
          <TBox args={[0.78, 2.9, 0.16]} color="#F6EEDF" position={[-0.42, 1.5, 0]} radius={0.04} outline={0.012} />
          <TBox args={[0.78, 2.9, 0.16]} color="#F6EEDF" position={[0.42, 1.5, 0]} radius={0.04} outline={0.012} />
          <mesh position={[-0.42, 2.1, 0.09]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.18, 0.18, 0.06, 20]} />
            <Skin color="#D8EEFF" outline={0.015} />
          </mesh>
          <mesh position={[0.42, 2.1, 0.09]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.18, 0.18, 0.06, 20]} />
            <Skin color="#D8EEFF" outline={0.015} />
          </mesh>
          <TBox args={[1.3, 0.42, 0.14]} color={C.rose} position={[0, 3.35, 0.02]} radius={0.1} />
          <Html center position={[0, 3.35, 0.15]} distanceFactor={7} style={{ pointerEvents: 'none' }} zIndexRange={[1, 1]}>
            <div className="sign3d">手术室</div>
          </Html>
          {zones?.enabled && (
            <Hot position={[0, 1.7, 0.2]} size={[1.8, 3.4, 0.5]} label="🚪 手术室 · 2点" onClick={zones.onSurgery} />
          )}
        </group>

        {/* ===== 药柜 ===== */}
        <group position={[-3.05, 0, -2.1]}>
          <TBox args={[1.34, 2.34, 0.62]} color={C.butter} position={[0, 1.17, 0]} radius={0.09} />
          <TBox args={[0.36, 0.11, 0.05]} color={C.roseDeep} position={[-0.32, 1.62, 0.33]} radius={0.02} outline={0.01} />
          <TBox args={[0.11, 0.36, 0.05]} color={C.roseDeep} position={[-0.32, 1.62, 0.33]} radius={0.02} outline={0.01} />
          <TBox args={[0.05, 0.26, 0.06]} color={C.line} position={[-0.1, 1.05, 0.33]} radius={0.02} outline={0} />
          <TBox args={[0.05, 0.26, 0.06]} color={C.line} position={[0.1, 1.05, 0.33]} radius={0.02} outline={0} />
          <Html center position={[0, 2.62, 0.2]} distanceFactor={7} style={{ pointerEvents: 'none' }} zIndexRange={[1, 1]}>
            <div className="sign3d mint">药 房</div>
          </Html>
          {zones?.enabled && (
            <Hot position={[0, 1.15, 0.3]} size={[1.55, 2.55, 1]} label="💊 药房 · 1点" onClick={zones.onCabinet} />
          )}
        </group>

        {/* ===== 挂钟 ===== */}
        <group position={[-1.1, 3.3, -2.42]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.44, 0.44, 0.1, 30]} />
            <Skin color={C.white} />
          </mesh>
          <group rotation={[0, 0, -clockAngle]}>
            <TBox args={[0.05, 0.3, 0.03]} color={C.line} position={[0, 0.14, 0.07]} radius={0.01} outline={0} />
          </group>
          <group rotation={[0, 0, -clockAngle * 2 - 2]}>
            <TBox args={[0.04, 0.22, 0.03]} color={C.roseDeep} position={[0, 0.1, 0.08]} radius={0.01} outline={0} />
          </group>
          {zones?.clockEnabled && (
            <Hot position={[0, 0, 0.2]} size={0.55} shape="sphere" label="🕐 结束回合 · 让时间过去" onClick={zones.onClock} />
          )}
        </group>

        {/* ===== 墙上电话 + 专家便签 ===== */}
        <group position={[0.4, 2.9, -2.42]}>
          <TBox args={[0.52, 0.72, 0.2]} color={C.lav} position={[0, 0, 0]} radius={0.08} />
          <mesh position={[0, 0.12, 0.12]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.1, 0.1, 0.05, 16]} />
            <Skin color={C.white} outline={0.012} />
          </mesh>
          <TBox args={[0.18, 0.2, 0.05]} color={C.white} position={[0, -0.18, 0.11]} radius={0.03} outline={0.012} />
          <Html center position={[0.62, -0.55, 0.2]} distanceFactor={7} style={{ pointerEvents: 'none' }} zIndexRange={[1, 1]}>
            <div className="sign3d note">专家×{zones?.expertLeft ?? 0}</div>
          </Html>
          {zones?.phoneEnabled && (
            <Hot position={[0, 0, 0.15]} size={[0.8, 1, 0.5]} label={`📞 呼叫专家 · 剩${zones.expertLeft}次`} onClick={zones.onPhone} />
          )}
        </group>

        {/* ===== 诊桌 + 桌上文件 ===== */}
        <group position={[-0.7, 0, -0.2]}>
          <TBox args={[2.5, 0.16, 1.16]} color={C.wood} position={[0, 1.02, 0]} radius={0.06} />
          <TBox args={[2.05, 0.92, 0.92]} color={C.cream2} position={[0, 0.48, 0]} radius={0.07} />
          <TBox args={[0.56, 0.09, 0.42]} color={C.sky} position={[-0.6, 1.15, 0.15]} radius={0.03} />
          <Hot position={[-0.6, 1.18, 0.15]} size={[0.7, 0.3, 0.55]} label="📖 病历本 · 完整记录" onClick={zones?.onBook} />
          <TBox args={[0.52, 0.03, 0.38]} color={C.white} position={[0.35, 1.12, 0.2]} rotation={[0, -0.12, 0]} radius={0.012} outline={0.01} />
          {zones?.enabled && (
            <Hot position={[0.35, 1.17, 0.2]} size={[0.65, 0.28, 0.5]} label="📋 检查申请单" onClick={zones.onOrders} />
          )}
          <mesh position={[0.95, 1.2, -0.25]}>
            <cylinderGeometry args={[0.09, 0.08, 0.22, 14]} />
            <Skin color={C.mint} outline={0.015} />
          </mesh>
        </group>

        {/* ===== 病人凳 ===== */}
        <group position={[1.4, 0, 0]}>
          <mesh position={[0, 0.5, 0]}>
            <cylinderGeometry args={[0.44, 0.44, 0.16, 22]} />
            <Skin color={C.butter} />
          </mesh>
          <mesh position={[0, 0.25, 0]}>
            <cylinderGeometry args={[0.06, 0.09, 0.5, 12]} />
            <Skin color={C.line} outline={0} />
          </mesh>
          {zones?.enabled && zones.onStoolMove && (
            <Hot position={[0, 0.6, 0]} size={[1, 0.6, 1]} label="🪑 让他回凳子坐" onClick={zones.onStoolMove} />
          )}
        </group>

        {/* ===== 病床 ===== */}
        <group position={[3.7, 0, 0]}>
          <TBox args={[2.74, 0.4, 1.3]} color={C.cream2} position={[0, 0.56, 0]} radius={0.08} />
          <TBox args={[2.62, 0.26, 1.18]} color={C.white} position={[0, 0.88, 0]} radius={0.1} />
          <TBox args={[0.16, 1.0, 1.3]} color={C.butter} position={[-1.36, 0.78, 0]} radius={0.07} />
          <TBox args={[0.14, 0.92, 1.18]} color={C.butter} position={[1.34, 0.8, 0]} radius={0.06} />
          <mesh position={[-1.05, 0.16, 0.42]}>
            <sphereGeometry args={[0.11, 12, 12]} />
            <Skin color={C.white} outline={0.015} />
          </mesh>
          <mesh position={[1.05, 0.16, 0.42]}>
            <sphereGeometry args={[0.11, 12, 12]} />
            <Skin color={C.white} outline={0.015} />
          </mesh>
          <TBox args={[0.58, 0.18, 0.74]} color={C.white} position={[-1.02, 1.06, 0]} radius={0.08} />
          {loc === 'bed' && !bedSitting && game.phase !== 'cured' && (
            <TBox args={[1.5, 0.22, 1.08]} color={C.mint} position={[0.52, 1.04, 0]} radius={0.1} />
          )}
          {bedSitting && <TBox args={[1.44, 0.2, 1.08]} color={C.mint} position={[0.55, 1.0, 0]} radius={0.09} />}
          {zones?.enabled && zones.onBedMove && (
            <Hot position={[0.2, 1.1, 0]} size={[2.6, 0.7, 1.35]} label="🛏 让他上床躺下" onClick={zones.onBedMove} />
          )}
        </group>

        {/* ===== 输液架 ===== */}
        {iv && (
          <group position={[2.35, 0, -0.75]}>
            <mesh position={[0, 1.2, 0]}>
              <cylinderGeometry args={[0.035, 0.035, 2.4, 10]} />
              <Skin color={C.line} outline={0} />
            </mesh>
            <TBox args={[0.26, 0.42, 0.16]} color={C.sky} position={[0, 2.25, 0]} radius={0.07} />
          </group>
        )}

        {/* ===== 角色(骨骼动画) ===== */}
        <Suspense fallback={null}>
          <PatientChar
            url={patientModel}
            pose={effPose}
            shaking={game.phase === 'critical'}
            scale={patientScale}
            tag={patientTag}
          />
          {guardian && (
            <group position={guardianAt} rotation={[0, guardianFacing, 0]}>
              <Char url={guardianModel} clip="Idle" />
            </group>
          )}
          <Doctor3D target={docTarget[docAt]} facing={docFacing[docAt]} />
        </Suspense>

        {/* 身体热区:头/胸口/腹部 */}
        {zones?.enabled && (
          <group>
            <Hot position={spots.head as [number, number, number]} size={0.52} shape="sphere" label="🗣 问诊 · 跟他说话" onClick={zones.onHead} />
            {zones.chest && (
              <Hot
                position={spots.chest as [number, number, number]}
                size={0.28}
                shape="sphere"
                label={`🩺 ${zones.chest.label}`}
                onClick={zones.chest.onClick}
              />
            )}
            {zones.abdomen && (
              <group position={spots.belly as [number, number, number]}>
                <mesh
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    pressAt.current = Date.now();
                    setPressing(true);
                  }}
                  onPointerUp={(e) => {
                    e.stopPropagation();
                    endPress(true);
                  }}
                  onPointerOver={() => (document.body.style.cursor = 'pointer')}
                  onPointerOut={() => {
                    document.body.style.cursor = 'default';
                    endPress(false);
                  }}
                >
                  <sphereGeometry args={[0.3, 16, 16]} />
                  <meshBasicMaterial color={C.rose} transparent opacity={pressing ? 0.4 : 0.08} depthWrite={false} />
                </mesh>
                {pressing && <Chip text="正在按压…松手看反应" y={0.6} />}
                {pressHint && <Chip text="触诊要按住一会儿再松开" warn y={0.6} />}
                {!pressing && !pressHint && guide && <Chip text="👉 按住他的腹部触诊" y={0.6} />}
              </group>
            )}
            {guide && zones.abdomen && <GuideRing position={spots.belly as [number, number, number]} />}
          </group>
        )}
      </Canvas>

      {/* 患者气泡 / 提示 / 弹层(沿用 2D 的 HTML 层) */}
      {bubble && bubble.text && (
        <div className="stage-bubble" style={{ left: loc === 'stool' ? '34%' : '52%' }}>
          {bubble.text}
          {!bubble.done && <span className="cursor">▌</span>}
        </div>
      )}
      {zones?.enabled && (
        <div className="stage-hint">🖱 3D 诊室:病人 · 桌上病历本/申请单 · 药柜 · 手术门 · 挂钟 · 电话 · 床/凳都能点</div>
      )}
      {overlay}
    </div>
  );
}
