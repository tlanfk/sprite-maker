// Codex에게 보낼 지시문. 지침의 프롬프트 원칙:
// - 승인된 기준 모델 그림을 참고로 붙이고 "같은 모델"을 유지하게 한다.
// - 색은 헥스 코드만 적지 않고 재질 이름·색 이름·명암으로 전달한다.
import { colorWord } from './color.js';

export const TYPES = {
  human:  { ko: '사람형', hint: '두 발로 서는 사람·로봇·괴물', en: 'a bipedal humanoid character standing on two legs' },
  animal: { ko: '동물형', hint: '네 발 동물이나 짐승·생물', en: 'an animal or creature standing naturally on its legs' },
  free:   { ko: '자유형', hint: '슬라임·사물·특이한 모양 등 그 밖의 것', en: 'a single subject: a monster, slime, object or anything else' },
};

export const VIEWS = {
  side:    { ko: '횡스크롤', desc: '옆에서 보는 시점이에요. 캐릭터가 주로 좌우로 움직여요.',
             en: 'Side view for a 2D side-scrolling game: the camera is at eye level and looks at the subject straight from the side.' },
  low:     { ko: '탑뷰', desc: '위에서 비스듬히 내려다봐요. 앞모습과 바닥이 함께 보여요.',
             en: 'Low top-down view (classic RPG angle): the camera looks down at about 30 degrees, so the front of the subject and the ground are both visible.' },
  high:    { ko: '높은 탑뷰', desc: '거의 바로 위에서 내려다봐요. 지형과 배치가 잘 보여요.',
             en: 'High top-down view: the camera is high above, looking down at about 65 degrees, so the top of the head and shoulders are clearly visible and the body is foreshortened.' },
  oblique: { ko: '오블리크', desc: '원근 왜곡 없이 윗면과 앞면이 함께 보이는 투영 방식이에요.',
             en: 'Oblique projection: no perspective distortion, parallel lines stay parallel, and the top face and the front face are visible at the same time.' },
};

export const FACING = {
  S:  'facing directly toward the viewer (front view)',
  N:  'facing directly away from the viewer (back view, we see the back of the subject)',
  W:  'facing to the LEFT side of the image (left side profile)',
  E:  'facing to the RIGHT side of the image (right side profile)',
  SW: 'turned three-quarters toward the viewer and to the LEFT (front-left 3/4 view)',
  SE: 'turned three-quarters toward the viewer and to the RIGHT (front-right 3/4 view)',
  NW: 'turned three-quarters away from the viewer, toward the upper LEFT (back-left 3/4 view)',
  NE: 'turned three-quarters away from the viewer, toward the upper RIGHT (back-right 3/4 view)',
};

const STYLE = [
  'Crisp, grid-aligned pixel art with consistent pixel density. No blur, no anti-aliasing, no gradients.',
  // 바깥 테두리는 제작기의 '외곽선' 설정으로만 두른다(Codex 테두리와 겹치지 않게)
  'Do NOT draw a dark outline around the outer silhouette: the outermost pixels use the subject\'s own colors, because the outline is added separately afterwards. Lines between inner parts are fine.',
  'Flat, solid, pure magenta (#FF00FF) background filling the whole image. No ground shadow, floor, scenery, border or frame.',
  'No text, letters, numbers, logos or watermark.',
];

const SAME_MODEL = 'Keep exactly the same model: the same head-to-body ratio, face, outfit, accessories, colors, silhouette proportions and pixel density. It is ONE model, not a redesign.';

// 최종 크기: 이 그림은 줄여서 작은 픽셀 칸에 담긴다. 그 칸 수에 맞는 굵은 도트로 그리게 한다.
function sizeRules(M) {
  const tall = Math.max(4, M.height);
  const block = Math.round(0.8 * 1024 / tall); // 그림 높이의 80%를 키 칸 수로 나눈 한 칸의 크기(그림 픽셀)
  const lines = [
    `Target size: the final sprite is a ${M.frame.w}x${M.frame.h} pixel frame, and the subject is about ${tall} pixels tall in it.`,
    `Draw it as pixel art designed for exactly that resolution: the whole subject is ${tall} big square pixel blocks tall — not more. Each block is about ${block}x${block} image pixels, all blocks the same size and aligned to one grid. Count the blocks.`,
  ];
  if (tall <= 24) {
    // 아주 작은 크기: 실제 16픽셀급 게임 캐릭터처럼 꼬마(2~3등신) 비율이어야 얼굴·몸이 칸 안에 들어간다
    lines.push(`This is a tiny sprite like classic 16-bit era game sprites. Use chibi (super-deformed) proportions: the head or main body part is big, about ${Math.round(tall * 0.42)} blocks tall (around 40% of the height), with a short body and short legs, and the subject is wide enough to read (not thin). Eyes are single blocks. Only the most important features, no small details.`);
  } else if (tall <= 40) {
    lines.push(`This is a small sprite: use slightly chibi proportions (head about a third of the height), big simple readable shapes, few colors per area, and no details smaller than one block.`);
  } else {
    lines.push('Keep shapes readable at that size and do not add details smaller than one block.');
  }
  return lines.join('\n');
}

// 종류·설명·시점: 세 지시문 모두에 넣는다(뒷모습·옆모습도 설명대로 그리게)
function subjectRules(M) {
  return [
    `Subject: ${TYPES[M.type].en}.`,
    M.description ? `Description: ${M.description}` : '',
    VIEWS[M.view].en,
  ].filter(Boolean).join('\n');
}

function colorRules(M) {
  if (!M.palette?.ramps?.length) {
    return `Use a limited palette of about ${M.budget} colors, organized as clear material color ramps (dark to light) — for example skin, hair, cloth, metal.`;
  }
  return 'Use only these approved material color ramps (each listed dark to light). Do not invent new colors; keep shadows and highlights inside each ramp:\n'
    + M.palette.ramps.map(r => `- ${r.name}: ${r.colors.map(colorWord).join(', ')}`).join('\n');
}

// 기준 모델: 정면 정지 1장
export function basePrompt(M, hasRef) {
  return [
    'Create the BASE MODEL of a pixel-art game sprite.',
    subjectRules(M),
    'Pose: neutral idle standing pose, facing directly toward the viewer (front view). The whole body is visible from top to bottom, centered, filling about 80% of the image height.',
    hasRef ? 'The attached image is a design reference: follow its design and colors, but redraw it cleanly as this base model.' : '',
    sizeRules(M),
    colorRules(M),
    ...STYLE,
  ].filter(Boolean).join('\n');
}

// 다른 방향: 승인된 기준 모델을 참고로
export function turnPrompt(M, d) {
  return [
    'The attached image is the APPROVED BASE MODEL of this sprite (front view), shown enlarged.',
    `Draw the same subject ${FACING[d]}, in the same neutral idle pose.`,
    SAME_MODEL,
    subjectRules(M),
    'Keep the same size in the image as the reference, whole body visible.',
    sizeRules(M),
    colorRules(M),
    ...STYLE,
  ].join('\n');
}

// 애니메이션: 그 방향의 정지 그림을 참고로, 1번 프레임은 참고 그림과 같은 자세
export function animPrompt(M, d, job, rows, cols) {
  return [
    'The attached image is the approved sprite of this model, shown enlarged.',
    `Create an animation sprite sheet of this SAME model performing ${job.text}.`,
    `The subject is ${FACING[d]} in every frame.`,
    `Exactly ${job.frames} frames in a grid of ${rows} row(s) and ${cols} columns, read left to right then top to bottom, in animation order.`,
    'Frame 1 must show exactly the same pose, size and facing as the reference image.',
    SAME_MODEL,
    subjectRules(M),
    'Animate in place. In each row the feet rest on the same ground line unless the action itself leaves the ground. Only the parts that the action needs may move.',
    'Leave clear empty space between frames: frames must never touch or overlap. No grid lines or frame numbers.',
    sizeRules(M),
    colorRules(M),
    ...STYLE,
  ].join('\n');
}
