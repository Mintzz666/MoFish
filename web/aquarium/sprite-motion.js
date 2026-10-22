const TAU = Math.PI * 2;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapAngle = angle => {
  const wrapped = ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return wrapped === -Math.PI && angle > 0 ? Math.PI : wrapped;
};

export function angleDelta(from, to) {
  const wrapped = ((to - from + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return wrapped === -Math.PI && to - from > 0 ? Math.PI : wrapped;
}

export function turnToward(current, target, maxStep) {
  const limit = Math.max(0, maxStep);
  return wrapAngle(current + clamp(angleDelta(current, target), -limit, limit));
}

/** Keep the fish's back above its belly while its nose tracks the travel direction. */
export function uprightFishPose(heading, maxTilt = 0.2) {
  const xDirection = Math.cos(heading);
  const yDirection = Math.sin(heading);
  const flipX = xDirection < 0;
  const facing = flipX ? -1 : 1;
  const lean = Math.atan2(yDirection, Math.abs(xDirection)) * facing;
  const tilt = clamp(lean, -Math.abs(maxTilt), Math.abs(maxTilt));
  return { flipX, tilt };
}
