import { useState } from 'react';
import { Monitor, Laptop, Terminal, Bot, Sparkles, Rocket, Upload } from 'lucide-react';
import {
  nodeIcons,
  maximumNodeIconLength,
  validNodeProfile,
  validNodeRemark,
  type NodeProfile,
} from '../shared/node-profile';
import type { RivloomNode } from '../shared/types';
import { Button, Field, Modal } from './ui';

const icons = {
  monitor: Monitor,
  laptop: Laptop,
  terminal: Terminal,
  bot: Bot,
  spark: Sparkles,
  rocket: Rocket,
};
const labels = {
  monitor: '台式机',
  laptop: '笔记本',
  terminal: '终端',
  bot: '机器人',
  spark: '星光',
  rocket: '火箭',
};

export function NodeAvatar({
  icon = 'monitor',
  name = '',
  small = false,
}: {
  icon?: string;
  name?: string;
  small?: boolean;
}) {
  const Icon = icons[icon as keyof typeof icons] || Monitor;
  const image = validNodeProfile({ name: name || 'Node', icon }) && icon.startsWith('data:image/');
  return (
    <span className={`node-avatar ${small ? 'small' : ''}`}>
      {image ? (
        <img src={icon} alt={`${name}的图标`} />
      ) : (
        <Icon size={small ? 15 : 22} aria-hidden="true" />
      )}
    </span>
  );
}

export function NodeProfileEditor({
  profile,
  busy,
  failureMessage,
  save,
  close,
}: {
  profile: NodeProfile;
  busy: boolean;
  failureMessage: string;
  save: (profile: NodeProfile) => Promise<boolean>;
  close: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [icon, setIcon] = useState(profile.icon);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  async function upload(file?: File) {
    if (!file) return;
    setError('');
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    ) {
      setError('请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片。');
      return;
    }
    setReading(true);
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d')!;
      const side = Math.min(bitmap.width, bitmap.height);
      context.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        64,
        64,
      );
      bitmap.close();
      let image = canvas.toDataURL('image/webp', 0.75);
      if (image.length > maximumNodeIconLength) image = canvas.toDataURL('image/webp', 0.35);
      if (image.length > maximumNodeIconLength)
        throw new Error('图片细节过多，请换一张更简单的图片。');
      setIcon(image);
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法读取图片。');
    } finally {
      setReading(false);
    }
  }
  return (
    <Modal title="我的 Node" subtitle="给这台机器一个容易辨认的名字和图标。" close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await save({ name: name.trim(), icon })) close();
        }}
      >
        <div className="profile-preview">
          <NodeAvatar name={name} icon={icon} />
          <strong>{name || '我的 Node'}</strong>
        </div>
        <Field label="Node 名称">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            required
            autoFocus
          />
        </Field>
        <div className="icon-picker" aria-label="选择节点图标">
          {nodeIcons.map((value) => (
            <button
              type="button"
              key={value}
              aria-label={labels[value]}
              aria-pressed={icon === value}
              onClick={() => setIcon(value)}
            >
              <NodeAvatar icon={value} />
            </button>
          ))}
        </div>
        <label className="image-upload">
          <Upload size={16} />
          {reading ? '正在处理图片…' : '上传图片'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            disabled={reading}
            onChange={(e) => void upload(e.target.files?.[0])}
          />
        </label>
        <p className="muted">名称和图标会同步给已配对的机器。</p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {failureMessage && (
          <p className="error" role="alert">
            {failureMessage}
          </p>
        )}
        <div className="modal-actions">
          <Button onClick={close}>取消</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || reading || !validNodeProfile({ name, icon })}
          >
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function NodeRemarkEditor({
  node,
  busy,
  failureMessage,
  save,
  close,
}: {
  node: RivloomNode;
  busy: boolean;
  failureMessage: string;
  save: (remark: string | null) => Promise<boolean>;
  close: () => void;
}) {
  const [remark, setRemark] = useState(node.remark || '');
  const normalized = remark.trim();
  return (
    <Modal title="Node 备注名" subtitle="备注只保存在这台机器，不会同步给对方。" close={close}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await save(normalized || null)) close();
        }}
      >
        <div className="remark-node-preview">
          <NodeAvatar name={node.name} icon={node.icon} />
          <span>
            <strong>{node.name}</strong>
            <small>{node.remark ? `当前备注：${node.remark}` : '尚未设置本地备注'}</small>
          </span>
        </div>
        <Field label="本地备注名" hint="留空保存可删除备注；最多 80 个字符。">
          <input
            value={remark}
            onChange={(event) => setRemark(event.target.value)}
            maxLength={80}
            placeholder="例如：设计组工作站"
            autoFocus
          />
        </Field>
        {failureMessage && (
          <p className="error" role="alert">
            {failureMessage}
          </p>
        )}
        <div className="modal-actions">
          <Button onClick={close}>取消</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy || (!!normalized && !validNodeRemark(normalized))}
          >
            保存
          </Button>
        </div>
      </form>
    </Modal>
  );
}
