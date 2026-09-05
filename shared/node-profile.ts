export const nodeIcons = ['monitor', 'laptop', 'terminal', 'bot', 'spark', 'rocket'] as const;
export type NodeProfile = { name: string; icon: string };
export const maximumNodeIconLength = 4096;

export function validNodeRemark(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function validNodeProfile(value: unknown): value is NodeProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { name, icon } = value as Record<string, unknown>;
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(name) &&
    typeof icon === 'string' &&
    icon.length <= maximumNodeIconLength &&
    ((nodeIcons as readonly string[]).includes(icon) ||
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(icon))
  );
}
