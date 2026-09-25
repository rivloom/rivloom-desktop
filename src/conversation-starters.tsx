import { ArrowUpRight, FileText, FolderSearch, ListChecks } from 'lucide-react';
import { t } from '../shared/i18n.ts';

/** Starters only populate the draft. Sending always uses the ordinary composer. */
export function ConversationStarters({ choose, disabled }: { choose: (text: string) => void; disabled: boolean }) {
  const starters = [
    { icon: FolderSearch, title: t('了解这个项目'), detail: t('梳理结构，找到下一步'),
      text: t('请先阅读当前工作文件夹，梳理项目结构、主要功能和使用方式，再建议下一步值得做的工作。先分析，不修改文件。') },
    { icon: ListChecks, title: t('检查当前改动'), detail: t('找出问题，说明验证方法'),
      text: t('请检查当前项目的改动，优先找出影响正确性和易用性的问题，说明具体位置、原因和建议的验证方法。先审查，不修改文件。') },
    { icon: FileText, title: t('整理一份文档'), detail: t('把材料变成清楚的说明'),
      text: t('请根据我提供的材料整理一份简洁清楚的文档，先列出结构，并标注还需要我补充的信息。') },
  ];
  return <div className="conversation-starters" role="group" aria-label={t('从这些任务开始')}>
    {starters.map(({ icon: Icon, title, detail, text }) => <button key={title} type="button" disabled={disabled}
      onClick={() => choose(text)}>
      <Icon size={19} aria-hidden="true" />
      <span><strong>{title}</strong><small>{detail}</small></span>
      <ArrowUpRight size={16} aria-hidden="true" />
    </button>)}
    <p>{t('选择后填入输入框，你可以修改后再发送。')}</p>
  </div>;
}
