// Isolated production UI + real knowledge APIs; synthetic Nodes, no engines or credentials.
import express from 'express';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startSearchPreview } from './conversation-search-preview.ts';
import { KnowledgeStore } from '../server/knowledge-store.ts';
import { KnowledgeNetwork } from '../server/knowledge-network.ts';
import { installKnowledgeAPI } from '../server/knowledge-api.ts';
import type { Bootstrap, BrainTopology, RivloomNode } from '../shared/types.ts';

const root = resolve('.data', 'knowledge-ui', String(Date.now())); mkdirSync(root, { recursive: true });
const nodeID = 'u'.repeat(32); const sourceID = 's'.repeat(32); const brainID = randomUUID(); const projectID = randomUUID();
const project = { id: projectID, name: '网站项目', directory: join(root, 'project'), trusted: true, createdAt: new Date().toISOString() }; mkdirSync(project.directory);
const brain = { id: brainID, name: '工作 Brain', masterNodeID: nodeID, hosted: true, state: 'established', online: true, queueDepth: 0, workers: [] } as BrainTopology;
const peer = (id: string, name: string): RivloomNode => ({ id, name, local: id === nodeID, online: true, trusted: true, channelReady: true, brains: [brain],
  fingerprint: 'UI fixture', protocolVersion: 1, addresses: ['127.0.0.1'], port: 0, verified: true, lastSeen: new Date().toISOString(), capabilities: [], worker: null });
const local = new KnowledgeStore(join(root, 'local'), nodeID); const source = new KnowledgeStore(join(root, 'source'), sourceID);
const sourceNetwork = new KnowledgeNetwork(source, { snapshot: () => ({ local: peer(sourceID, '素材 Node'), paired: [peer(nodeID, '我的 Node')], brains: [{ ...brain, hosted: false }] }), trusted: () => true, request: async () => { throw new Error('unexpected'); } });
const network = new KnowledgeNetwork(local, { snapshot: () => ({ local: peer(nodeID, '我的 Node'), paired: [peer(sourceID, '素材 Node')], brains: [brain] }), trusted: () => true, request: (_id, _op, data) => sourceNetwork.handle(nodeID, data) });
for (const [name, category, body] of [['张三的基本信息', '人物/张三/信息', '来源：用户明确提供。\n\n张三偏好先看结论，再看细节。'], ['张三的工作', '人物/张三/工作', '来源：项目说明。\n\n负责网站的设计与交付。'], ['项目决定', '项目/网站/决定', '采用简洁的知识库界面。']])
  local.saveMemory({ name, description: `${name}的已确认事实`, category, body, projectID: null }, 'user');
const shared = source.saveMemory({ name: '团队交付规范', description: '交付前需要检查的事项', category: '项目/网站/规范', body: '先检查内容，再核对交付文件。', projectID: null }, 'user'); source.share(shared.id, [brainID], shared.revision);
const directory = join(root, 'report-skill'); mkdirSync(directory); writeFileSync(join(directory, 'SKILL.md'), '---\nname: 项目周报\ndescription: 按项目进度整理周报，保留来源和待办。\n---\n# 项目周报\n\n先读取项目进度，再整理本周结果、风险和下一步。');
await local.registerSkill(directory, null); local.organize();
const remoteSkillDirectory = join(root, 'source-delivery-skill'); mkdirSync(remoteSkillDirectory);
mkdirSync(join(remoteSkillDirectory, 'references'));
writeFileSync(join(remoteSkillDirectory, 'SKILL.md'), '---\nname: 素材交付检查\ndescription: 按需读取交付清单，核对素材命名、尺寸与交付说明。\n---\n# 素材交付检查\n\n此示例由素材 Node 分享给工作 Brain。\n\n先确认任务的交付要求，再按需读取 references/checklist.md，逐项核对并报告缺失项。');
writeFileSync(join(remoteSkillDirectory, 'references', 'checklist.md'), '# 交付清单\n\n- 文件命名与任务要求一致。\n- 尺寸、格式和数量已核对。\n- 附上交付说明与待确认事项。\n');
const remoteSkill = await source.registerSkill(remoteSkillDirectory, null); source.share(remoteSkill.id, [brainID], remoteSkill.revision);
const app = express(); app.use(express.json({ limit: '512kb' })); let data: Bootstrap;
installKnowledgeAPI(app, () => ({ store: local, network }), () => data.user, () => [project]);
const distIndex = process.argv.indexOf('--dist');
const preview = await startSearchPreview(resolve(distIndex === -1 ? 'dist' : process.argv[distIndex + 1]), async (req, res, value) => {
  data = value; data.projects = [project]; data.user.name = '知识库验收';
  data.network.local = peer(nodeID, '我的 Node'); data.network.brains = [brain];
  if (!req.url?.startsWith('/api/knowledge')) return false;
  app(req, res); return true;
});
console.log(JSON.stringify({ url: preview.origin, root, skillDirectory: directory, remoteSkillDirectory }));
async function close() { await preview.close(); network.close(); sourceNetwork.close(); local.close(); source.close(); }
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
process.stdin.resume(); process.stdin.once('data', () => void close());
