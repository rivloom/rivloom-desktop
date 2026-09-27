import { t, systemText } from '../shared/i18n.ts';
export function officeMessage(code: string) {
  const messages: Record<string, string> = {
    office_destination_exists: t('目标文件已存在，请换一个名称；原文件未覆盖。'),
    office_too_large: t('文件较大，内置预览支持最大 32 MiB。请使用系统应用打开。'),
    office_invalid: t('文件损坏或格式无法读取，请使用系统应用检查。'),
    office_encrypted: t('此文件已加密，请先在本机解密后再预览。'),
    office_unsupported: t('此格式暂不支持内置预览，请使用系统应用打开。'),
    office_no_text: t('本页没有可提取的文字，可能是扫描件。页面仍可查看，文字识别暂未提供。'),
    office_busy: t('正在处理其他文件，请稍后重试。'),
    office_timeout: t('文件解析超时，请使用系统应用打开。'),
    office_unavailable: t('文件暂时无法读取，请刷新后重试。'),
    office_path: t('文件不在可访问的项目范围内，或路径已改变。'),
    office_changed: t('文件已被其他程序修改。请保留你的草稿，重新读取后再保存。'),
    office_edit_unavailable: t('仅支持完整读取的 UTF-8 TXT、Markdown 文件编辑，最大 256 KiB。'),
    office_owner_only: t('只有工作区创建者可以浏览项目文件。'),
    office_project_missing: t('项目不存在，请重新选择。'),
    office_cached_formulas: t('显示文件保存时的公式结果；未重新计算公式。'),
    office_columns_truncated: t('仅显示前 100 列，请使用系统应用查看完整表格。'),
    office_cells_truncated: t('部分单元格内容较长，预览已截断。'),
    office_text_truncated: t('本批文字摘录已截断，请缩小读取范围核对内容。'),
    office_images_omitted: t('部分图片格式不支持或过大，已略过。'),
    office_layout_omitted: t('文档版式较大，当前显示文字摘录。'),
    office_layout_approximate: t('当前为阅读预览，部分版式可能与原文档不同。'),
    office_page: t('此页不存在。'), office_sheet: t('此工作表不存在。'),
  }; return messages[code] || systemText(code);
}
