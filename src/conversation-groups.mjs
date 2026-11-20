import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const STORE_VERSION = 1;
const MAX_GROUP_NAME_LENGTH = 48;
export const MAX_GROUP_DEPTH = 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function atomicWriteFile(filePath, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
  if (process.platform !== 'win32') {
    fs.chmodSync(tmpPath, mode);
  }
  fs.renameSync(tmpPath, filePath);
}

function normalizeName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!name) {
    throw new Error('分组名称不能为空');
  }
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    return name.slice(0, MAX_GROUP_NAME_LENGTH);
  }
  return name;
}

function normalizeItem(raw) {
  const cascadeId = String(raw?.cascadeId || '').trim();
  if (!UUID_RE.test(cascadeId)) return null;
  const title = String(raw?.title || '').replace(/\s+/g, ' ').trim();
  const project = String(raw?.project || '').replace(/\s+/g, ' ').trim();
  const addedAt = String(raw?.addedAt || '').trim() || new Date().toISOString();
  return {
    cascadeId,
    title: title || '未命名对话',
    project,
    addedAt,
  };
}

function getGroupDepth(byId, groupId) {
  let depth = 0;
  let cur = byId.get(groupId);
  const visited = new Set([groupId]);
  while (cur && cur.parentId) {
    if (visited.has(cur.parentId)) return -1;
    const parent = byId.get(cur.parentId);
    if (!parent) return -1;
    visited.add(cur.parentId);
    depth += 1;
    cur = parent;
  }
  return depth;
}

function collectDescendantIds(groups, rootId) {
  const result = new Set([rootId]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const g of groups) {
      if (g.parentId && result.has(g.parentId) && !result.has(g.id)) {
        result.add(g.id);
        expanded = true;
      }
    }
  }
  return result;
}

function getSubtreeMaxRelativeDepth(groups, rootId) {
  const childrenMap = new Map();
  for (const g of groups) {
    if (!g.parentId) continue;
    let list = childrenMap.get(g.parentId);
    if (!list) {
      list = [];
      childrenMap.set(g.parentId, list);
    }
    list.push(g.id);
  }
  const visited = new Set([rootId]);
  const dfs = (id) => {
    const kids = childrenMap.get(id) || [];
    let maxSub = 0;
    for (const kid of kids) {
      if (visited.has(kid)) continue;
      visited.add(kid);
      maxSub = Math.max(maxSub, 1 + dfs(kid));
    }
    return maxSub;
  };
  return dfs(rootId);
}

function expandAncestorChain(store, groupId) {
  store.collapsedSection = false;
  if (!groupId) return;
  const byId = new Map(store.groups.map((g) => [g.id, g]));
  const visited = new Set();
  let cur = byId.get(groupId);
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    cur.collapsed = false;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
}

function normalizeStore(parsed) {
  const rawGroups = Array.isArray(parsed?.groups) ? parsed.groups : [];
  const seenGroupIds = new Set();
  const groups = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== 'object') continue;
    const id = String(g.id || '').trim() || `grp_${crypto.randomBytes(5).toString('hex')}`;
    if (seenGroupIds.has(id)) continue;
    const name = String(g.name || '').replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME_LENGTH);
    if (!name) continue;
    seenGroupIds.add(id);

    const seenItemIds = new Set();
    const items = [];
    for (const rawItem of Array.isArray(g.items) ? g.items : []) {
      const item = normalizeItem(rawItem);
      if (!item) continue;
      const key = item.cascadeId.toLowerCase();
      if (seenItemIds.has(key)) continue;
      seenItemIds.add(key);
      items.push(item);
    }

    groups.push({
      id,
      name,
      parentId: String(g.parentId || '').trim(),
      collapsed: Boolean(g.collapsed),
      items,
    });
  }

  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const g of groups) {
    if (!g.parentId) continue;
    if (g.parentId === g.id || !byId.has(g.parentId)) {
      g.parentId = '';
      continue;
    }
    const depth = getGroupDepth(byId, g.id);
    if (depth < 0 || depth >= MAX_GROUP_DEPTH) {
      g.parentId = '';
    }
  }

  return {
    version: STORE_VERSION,
    collapsedSection: Boolean(parsed?.collapsedSection),
    groups,
  };
}

export function readConversationGroupsStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { version: STORE_VERSION, collapsedSection: false, groups: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return normalizeStore(parsed);
  } catch {
    return { version: STORE_VERSION, collapsedSection: false, groups: [] };
  }
}

export function writeConversationGroupsStore(filePath, store) {
  const normalized = normalizeStore(store);
  atomicWriteFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 0o600);
  return normalized;
}

export function createConversationGroup(filePath, { name, parentId = '', initialItem = null } = {}) {
  const cleanName = normalizeName(name);
  const cleanParentId = String(parentId || '').trim();
  const store = readConversationGroupsStore(filePath);
  const byId = new Map(store.groups.map((g) => [g.id, g]));

  if (cleanParentId) {
    if (!byId.has(cleanParentId)) {
      throw new Error('父分组不存在');
    }
    const parentDepth = getGroupDepth(byId, cleanParentId);
    if (parentDepth < 0 || parentDepth + 1 >= MAX_GROUP_DEPTH) {
      throw new Error(`最多支持 ${MAX_GROUP_DEPTH} 级嵌套分组`);
    }
  }

  const dup = store.groups.some(
    (g) => g.parentId === cleanParentId && g.name.toLowerCase() === cleanName.toLowerCase()
  );
  if (dup) {
    throw new Error(`已存在同名分组“${cleanName}”`);
  }

  const items = [];
  if (initialItem) {
    const normalizedItem = normalizeItem(initialItem);
    if (normalizedItem) items.push(normalizedItem);
  }
  const group = {
    id: `grp_${crypto.randomBytes(5).toString('hex')}`,
    name: cleanName,
    parentId: cleanParentId,
    collapsed: false,
    items,
  };
  store.groups.push(group);
  expandAncestorChain(store, cleanParentId);
  const saved = writeConversationGroupsStore(filePath, store);
  return { store: saved, group };
}

export function renameConversationGroup(filePath, { groupId, name } = {}) {
  const id = String(groupId || '').trim();
  const cleanName = normalizeName(name);
  const store = readConversationGroupsStore(filePath);
  const target = store.groups.find((g) => g.id === id);
  if (!target) {
    throw new Error('分组不存在');
  }
  const dup = store.groups.some(
    (g) => g.id !== id && g.parentId === target.parentId && g.name.toLowerCase() === cleanName.toLowerCase()
  );
  if (dup) {
    throw new Error(`已存在同名分组“${cleanName}”`);
  }
  target.name = cleanName;
  return writeConversationGroupsStore(filePath, store);
}

export function deleteConversationGroup(filePath, { groupId } = {}) {
  const id = String(groupId || '').trim();
  const store = readConversationGroupsStore(filePath);
  if (!id || !store.groups.some((g) => g.id === id)) {
    return store;
  }
  const toRemove = collectDescendantIds(store.groups, id);
  const next = store.groups.filter((g) => !toRemove.has(g.id));
  if (next.length === store.groups.length) {
    return store;
  }
  store.groups = next;
  return writeConversationGroupsStore(filePath, store);
}

export function toggleConversationGroupCollapse(filePath, { groupId = '', section = false } = {}) {
  const store = readConversationGroupsStore(filePath);
  if (section) {
    store.collapsedSection = !store.collapsedSection;
    return writeConversationGroupsStore(filePath, store);
  }
  const id = String(groupId || '').trim();
  const target = store.groups.find((g) => g.id === id);
  if (!target) return store;
  target.collapsed = !target.collapsed;
  return writeConversationGroupsStore(filePath, store);
}

export function addConversationToGroup(filePath, { groupId, item } = {}) {
  const id = String(groupId || '').trim();
  const normalizedItem = normalizeItem(item);
  if (!normalizedItem) {
    throw new Error('无效的对话标识');
  }
  const store = readConversationGroupsStore(filePath);
  const target = store.groups.find((g) => g.id === id);
  if (!target) {
    throw new Error('分组不存在');
  }
  const idx = target.items.findIndex(
    (it) => it.cascadeId.toLowerCase() === normalizedItem.cascadeId.toLowerCase()
  );
  if (idx >= 0) {
    const prev = target.items[idx];
    target.items[idx] = {
      ...prev,
      title: normalizedItem.title || prev.title,
      project: normalizedItem.project || prev.project,
    };
  } else {
    target.items.unshift(normalizedItem);
  }
  target.collapsed = false;
  expandAncestorChain(store, target.id);
  return writeConversationGroupsStore(filePath, store);
}

export function removeConversationFromGroup(filePath, { groupId, cascadeId } = {}) {
  const id = String(groupId || '').trim();
  const cid = String(cascadeId || '').trim().toLowerCase();
  if (!id || !cid) return readConversationGroupsStore(filePath);
  const store = readConversationGroupsStore(filePath);
  const target = store.groups.find((g) => g.id === id);
  if (!target) return store;
  const nextItems = target.items.filter((it) => it.cascadeId.toLowerCase() !== cid);
  if (nextItems.length === target.items.length) return store;
  target.items = nextItems;
  return writeConversationGroupsStore(filePath, store);
}

export function moveConversationBetweenGroups(filePath, { fromGroupId, toGroupId, item } = {}) {
  const fromId = String(fromGroupId || '').trim();
  const toId = String(toGroupId || '').trim();
  const normalizedItem = normalizeItem(item);
  if (!normalizedItem) {
    throw new Error('无效的对话标识');
  }
  const store = readConversationGroupsStore(filePath);
  const target = store.groups.find((g) => g.id === toId);
  if (!target) {
    throw new Error('分组不存在');
  }
  const cidLower = normalizedItem.cascadeId.toLowerCase();
  if (fromId && fromId !== toId) {
    const source = store.groups.find((g) => g.id === fromId);
    if (source) {
      source.items = source.items.filter((it) => it.cascadeId.toLowerCase() !== cidLower);
    }
  }
  const idx = target.items.findIndex((it) => it.cascadeId.toLowerCase() === cidLower);
  if (idx >= 0) {
    const prev = target.items[idx];
    target.items[idx] = {
      ...prev,
      title: normalizedItem.title || prev.title,
      project: normalizedItem.project || prev.project,
    };
  } else {
    target.items.unshift(normalizedItem);
  }
  target.collapsed = false;
  expandAncestorChain(store, target.id);
  return writeConversationGroupsStore(filePath, store);
}

export function moveConversationGroup(
  filePath,
  { groupId, parentId = '', beforeGroupId = '', afterGroupId = '' } = {}
) {
  const id = String(groupId || '').trim();
  const nextParentId = String(parentId || '').trim();
  const beforeId = String(beforeGroupId || '').trim();
  const afterId = String(afterGroupId || '').trim();
  const store = readConversationGroupsStore(filePath);
  const byId = new Map(store.groups.map((g) => [g.id, g]));
  const moving = byId.get(id);
  if (!moving) {
    throw new Error('分组不存在');
  }

  if (nextParentId) {
    if (!byId.has(nextParentId)) {
      throw new Error('目标父分组不存在');
    }
    const descendants = collectDescendantIds(store.groups, id);
    if (descendants.has(nextParentId)) {
      throw new Error('不能将分组移动到自身或其子分组内');
    }
    const parentDepth = getGroupDepth(byId, nextParentId);
    const subtreeHeight = getSubtreeMaxRelativeDepth(store.groups, id);
    if (parentDepth < 0 || parentDepth + 1 + subtreeHeight >= MAX_GROUP_DEPTH) {
      throw new Error(`最多支持 ${MAX_GROUP_DEPTH} 级嵌套分组`);
    }
  }

  const dup = store.groups.some(
    (g) => g.id !== id && g.parentId === nextParentId && g.name.toLowerCase() === moving.name.toLowerCase()
  );
  if (dup) {
    throw new Error(`目标位置已存在同名分组“${moving.name}”`);
  }

  const prevParentId = moving.parentId;
  const prevOrder = store.groups.map((g) => g.id);
  moving.parentId = nextParentId;

  const without = store.groups.filter((g) => g.id !== id);
  if (beforeId && beforeId !== id) {
    const targetIdx = without.findIndex((g) => g.id === beforeId);
    if (targetIdx >= 0) {
      without.splice(targetIdx, 0, moving);
    } else {
      without.push(moving);
    }
  } else if (afterId && afterId !== id) {
    const targetIdx = without.findIndex((g) => g.id === afterId);
    if (targetIdx >= 0) {
      without.splice(targetIdx + 1, 0, moving);
    } else {
      without.push(moving);
    }
  } else if (prevParentId !== nextParentId) {
    without.push(moving);
  } else {
    // Same parent and no explicit anchor: keep position unchanged
    return store;
  }

  const orderChanged = without.some((g, idx) => g.id !== prevOrder[idx]);
  if (!orderChanged && prevParentId === nextParentId) {
    return store;
  }

  store.groups = without;
  if (nextParentId) {
    expandAncestorChain(store, nextParentId);
  }
  return writeConversationGroupsStore(filePath, store);
}

export function reorderConversationGroups(filePath, { orderedIds, parentId } = {}) {
  const store = readConversationGroupsStore(filePath);
  if (!Array.isArray(orderedIds) || orderedIds.length < 2 || store.groups.length < 2) {
    return store;
  }

  if (parentId !== undefined) {
    const pid = String(parentId || '').trim();
    const siblings = store.groups.filter((g) => g.parentId === pid);
    if (siblings.length < 2) return store;
    const byId = new Map(siblings.map((g) => [g.id, g]));
    const reordered = [];
    const seen = new Set();
    for (const rawId of orderedIds) {
      const id = String(rawId || '').trim();
      if (!seen.has(id) && byId.has(id)) {
        seen.add(id);
        reordered.push(byId.get(id));
      }
    }
    for (const g of siblings) {
      if (!seen.has(g.id)) reordered.push(g);
    }
    let cursor = 0;
    const next = store.groups.map((g) => (g.parentId === pid ? reordered[cursor++] : g));
    const changed = next.some((g, i) => g.id !== store.groups[i]?.id);
    if (!changed) return store;
    store.groups = next;
    return writeConversationGroupsStore(filePath, store);
  }

  const byId = new Map(store.groups.map((g) => [g.id, g]));
  const next = [];
  const seen = new Set();
  for (const rawId of orderedIds) {
    const id = String(rawId || '').trim();
    if (!seen.has(id) && byId.has(id)) {
      seen.add(id);
      next.push(byId.get(id));
    }
  }
  for (const g of store.groups) {
    if (!seen.has(g.id)) next.push(g);
  }
  const changed = next.some((g, i) => g.id !== store.groups[i]?.id);
  if (!changed) return store;
  store.groups = next;
  return writeConversationGroupsStore(filePath, store);
}

export function syncConversationMetadata(filePath, metadataMap = {}) {
  if (!metadataMap || typeof metadataMap !== 'object') {
    return { store: readConversationGroupsStore(filePath), changed: false };
  }
  const store = readConversationGroupsStore(filePath);
  let changed = false;
  for (const group of store.groups) {
    for (const item of group.items) {
      const meta = metadataMap[item.cascadeId] || metadataMap[item.cascadeId.toLowerCase()];
      if (!meta || typeof meta !== 'object') continue;
      const nextTitle = String(meta.title || '').replace(/\s+/g, ' ').trim();
      const nextProject = String(meta.project || '').replace(/\s+/g, ' ').trim();
      if (nextTitle && nextTitle !== item.title) {
        item.title = nextTitle;
        changed = true;
      }
      if (nextProject && nextProject !== item.project) {
        item.project = nextProject;
        changed = true;
      }
    }
  }
  if (!changed) return { store, changed: false };
  return { store: writeConversationGroupsStore(filePath, store), changed: true };
}
