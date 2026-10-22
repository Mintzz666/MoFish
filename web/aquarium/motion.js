const MAX_STEP = 0.05;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function boundedDt(dt, maxStep = MAX_STEP) {
  if (!Number.isFinite(dt) || dt <= 0) return 0;
  return Math.min(dt, maxStep);
}

export function angleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function stepHeading(heading, target, turnRate, dt) {
  const step = boundedDt(dt);
  if (!step || !Number.isFinite(turnRate) || turnRate <= 0) return heading;
  return heading + clamp(angleDelta(heading, target), -turnRate * step, turnRate * step);
}

export function damp(current, target, response, dt) {
  const step = boundedDt(dt);
  if (!step || !Number.isFinite(response) || response <= 0) return current;
  return current + (target - current) * (1 - Math.exp(-response * step));
}

export function mixHeading(from, to, amount) {
  return from + angleDelta(from, to) * clamp(amount, 0, 1);
}

export function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

