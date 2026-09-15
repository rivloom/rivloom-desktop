import { t } from './i18n.ts';
export function knowledgeError(message: string) {
  if (!message.startsWith('knowledge_')) return '';
  if (/revision|catalog_changed|source_changed/.test(message)) return t('内容已更新，请重新打开并核对后再操作。运行中的任务保留原版本。');
  if (/not_shared|not_authorized|wrong_project|owner_only/.test(message)) return t('此内容未向当前范围分享，或你没有操作权限。');
  if (/offline|unavailable|timeout/.test(message)) return t('来源 Node 或 Brain 暂时不可用，无法确认最新版。请恢复连接后重试。');
  if (/unsafe/.test(message)) return t('文件路径不受支持。请选择普通文件夹，避免链接、凭据文件或特殊路径。');
  if (/frontmatter|metadata|manifest_invalid/.test(message)) return t('Skill 需要包含有效的 SKILL.md，以及 name 和 description。');
  if (/too_large|too_deep|full/.test(message)) return t('内容超过容量限制，请缩小文件夹或条目范围。');
  if (/starting/.test(message)) return t('技能与记忆库正在初始化，请稍后重试。');
  if (/not_found/.test(message)) return t('内容已移除，请刷新目录。');
  if (/busy/.test(message)) return t('知识库正在处理其他请求，请稍后重试。');
  return t('知识库操作未完成，请检查输入并重试。');
}
