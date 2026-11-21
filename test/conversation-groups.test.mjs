import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addConversationToGroup,
  createConversationGroup,
  deleteConversationGroup,
  moveConversationBetweenGroups,
  moveConversationGroup,
  readConversationGroupsStore,
  removeConversationFromGroup,
  renameConversationGroup,
  reorderConversationGroups,
  syncConversationMetadata,
  toggleConversationGroupCollapse,
} from '../src/conversation-groups.mjs';
import { buildClientScript } from '../src/daemon.mjs';

const CID_1 = '8866de7d-15be-40b5-9a89-ece7bdc73e24';
const CID_2 = '6eca6d45-0e6c-4724-bf7a-867c2f82ca4a';

test('conversation groups CRUD, collapse, reorder, and metadata sync work cleanly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-groups-test-'));
  const filePath = path.join(tmpDir, 'conversation-groups.json');

  try {
    const empty = readConversationGroupsStore(filePath);
    assert.deepEqual(empty, { version: 1, collapsedSection: false, groups: [] });

    const { store: s1, group: g1 } = createConversationGroup(filePath, {
      name: '  进行中  ',
      initialItem: { cascadeId: CID_1, title: '订阅修复', project: 'antigravity-quota-injector' },
    });
    assert.equal(s1.groups.length, 1);
    assert.equal(g1.name, '进行中');
    assert.equal(g1.items.length, 1);
    assert.equal(g1.items[0].cascadeId, CID_1);

    assert.throws(
      () => createConversationGroup(filePath, { name: '进行中' }),
      /已存在同名分组/
    );
    assert.throws(
      () => createConversationGroup(filePath, { name: '   ' }),
      /分组名称不能为空/
    );

    const { group: g2 } = createConversationGroup(filePath, { name: '待跟进' });

    // Add duplicate updates metadata without duplicating item; new item prepends
    let store = addConversationToGroup(filePath, {
      groupId: g1.id,
      item: { cascadeId: CID_1, title: '订阅修复 v2', project: 'antigravity-quota-injector' },
    });
    assert.equal(store.groups[0].items.length, 1);
    assert.equal(store.groups[0].items[0].title, '订阅修复 v2');

    store = addConversationToGroup(filePath, {
      groupId: g1.id,
      item: { cascadeId: CID_2, title: '磁盘清理', project: 'EcoPaste' },
    });
    assert.deepEqual(
      store.groups[0].items.map((it) => it.cascadeId),
      [CID_2, CID_1]
    );

    // Rename & collapse
    store = renameConversationGroup(filePath, { groupId: g2.id, name: '归档备忘' });
    assert.equal(store.groups[1].name, '归档备忘');

    store = toggleConversationGroupCollapse(filePath, { groupId: g1.id });
    assert.equal(store.groups[0].collapsed, true);

    store = toggleConversationGroupCollapse(filePath, { section: true });
    assert.equal(store.collapsedSection, true);

    // Reorder
    store = reorderConversationGroups(filePath, { orderedIds: [g2.id, g1.id] });
    assert.deepEqual(
      store.groups.map((g) => g.id),
      [g2.id, g1.id]
    );

    // Metadata sync only writes when changed
    const syncNoop = syncConversationMetadata(filePath, {
      [CID_2]: { title: '磁盘清理', project: 'EcoPaste' },
    });
    assert.equal(syncNoop.changed, false);

    const syncHit = syncConversationMetadata(filePath, {
      [CID_2]: { title: '电脑磁盘空间清理建议', project: 'EcoPaste' },
    });
    assert.equal(syncHit.changed, true);
    assert.equal(syncHit.store.groups[1].items[0].title, '电脑磁盘空间清理建议');

    // Move item between groups (removes from source, unshifts into target, expands collapsed)
    store = toggleConversationGroupCollapse(filePath, { groupId: g2.id });
    assert.equal(store.groups[0].collapsed, true);

    store = moveConversationBetweenGroups(filePath, {
      fromGroupId: g1.id,
      toGroupId: g2.id,
      item: { cascadeId: CID_2, title: '电脑磁盘空间清理建议', project: 'EcoPaste' },
    });
    assert.equal(store.collapsedSection, false);
    assert.equal(store.groups[0].collapsed, false);
    assert.deepEqual(
      store.groups[0].items.map((it) => it.cascadeId),
      [CID_2]
    );
    assert.deepEqual(
      store.groups[1].items.map((it) => it.cascadeId),
      [CID_1]
    );

    // Move back to g1 so subsequent remove assertion exercises removeConversationFromGroup
    store = moveConversationBetweenGroups(filePath, {
      fromGroupId: g2.id,
      toGroupId: g1.id,
      item: { cascadeId: CID_2, title: '电脑磁盘空间清理建议', project: 'EcoPaste' },
    });
    assert.deepEqual(store.groups[0].items, []);
    assert.deepEqual(
      store.groups[1].items.map((it) => it.cascadeId),
      [CID_2, CID_1]
    );

    // Remove item & delete group
    store = removeConversationFromGroup(filePath, { groupId: g1.id, cascadeId: CID_2 });
    assert.deepEqual(
      store.groups[1].items.map((it) => it.cascadeId),
      [CID_1]
    );

    store = deleteConversationGroup(filePath, { groupId: g2.id });
    assert.deepEqual(
      store.groups.map((g) => g.id),
      [g1.id]
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('nested subgroups support creation, same-name siblings across parents, depth limit, move, ancestor expansion, and cascade delete', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-subgroups-test-'));
  const filePath = path.join(tmpDir, 'conversation-groups.json');

  try {
    const { group: work } = createConversationGroup(filePath, { name: '工作' });
    const { group: personal } = createConversationGroup(filePath, { name: '个人' });

    // Same subgroup name allowed under different parents, blocked under same parent
    const { group: workTodo } = createConversationGroup(filePath, { name: '待办', parentId: work.id });
    const { group: personalTodo } = createConversationGroup(filePath, { name: '待办', parentId: personal.id });
    assert.equal(workTodo.parentId, work.id);
    assert.equal(personalTodo.parentId, personal.id);
    assert.throws(
      () => createConversationGroup(filePath, { name: '待办', parentId: work.id }),
      /已存在同名分组/
    );

    // Depth up to 4 levels (0 -> 1 -> 2 -> 3), 5th rejected
    const { group: lvl2 } = createConversationGroup(filePath, { name: '前端', parentId: workTodo.id });
    const { group: lvl3 } = createConversationGroup(filePath, { name: '样式', parentId: lvl2.id });
    assert.equal(lvl3.parentId, lvl2.id);
    assert.throws(
      () => createConversationGroup(filePath, { name: '按钮', parentId: lvl3.id }),
      /最多支持 4 级嵌套分组/
    );

    // Collapse ancestors, then adding item into lvl3 expands entire ancestor chain
    toggleConversationGroupCollapse(filePath, { groupId: work.id });
    toggleConversationGroupCollapse(filePath, { groupId: workTodo.id });
    toggleConversationGroupCollapse(filePath, { groupId: lvl2.id });
    toggleConversationGroupCollapse(filePath, { groupId: lvl3.id });
    let store = addConversationToGroup(filePath, {
      groupId: lvl3.id,
      item: { cascadeId: CID_1, title: '图标对齐', project: 'antigravity-quota-injector' },
    });
    for (const id of [work.id, workTodo.id, lvl2.id, lvl3.id]) {
      assert.equal(store.groups.find((g) => g.id === id)?.collapsed, false);
    }

    // Cannot move a group into itself or its descendant
    assert.throws(
      () => moveConversationGroup(filePath, { groupId: work.id, parentId: lvl2.id }),
      /不能将分组移动到自身或其子分组内/
    );

    // Cannot move subtree if resulting depth exceeds MAX_GROUP_DEPTH
    assert.throws(
      () => moveConversationGroup(filePath, { groupId: workTodo.id, parentId: personalTodo.id }),
      /最多支持 4 级嵌套分组/
    );

    // Move lvl3 out to top-level before personal
    store = moveConversationGroup(filePath, {
      groupId: lvl3.id,
      parentId: '',
      beforeGroupId: personal.id,
    });
    assert.equal(store.groups.find((g) => g.id === lvl3.id)?.parentId, '');
    const topIds = store.groups.filter((g) => !g.parentId).map((g) => g.id);
    assert.deepEqual(topIds, [work.id, lvl3.id, personal.id]);

    // Move work after personal via afterGroupId
    store = moveConversationGroup(filePath, {
      groupId: work.id,
      parentId: '',
      afterGroupId: personal.id,
    });
    assert.deepEqual(
      store.groups.filter((g) => !g.parentId).map((g) => g.id),
      [lvl3.id, personal.id, work.id]
    );

    // Move lvl3 into personalTodo
    store = moveConversationGroup(filePath, { groupId: lvl3.id, parentId: personalTodo.id });
    assert.equal(store.groups.find((g) => g.id === lvl3.id)?.parentId, personalTodo.id);

    // Deleting a parent cascades to all descendants without touching other trees
    store = deleteConversationGroup(filePath, { groupId: work.id });
    const remainingIds = store.groups.map((g) => g.id);
    assert.equal(remainingIds.includes(work.id), false);
    assert.equal(remainingIds.includes(workTodo.id), false);
    assert.equal(remainingIds.includes(lvl2.id), false);
    assert.equal(remainingIds.includes(personal.id), true);
    assert.equal(remainingIds.includes(personalTodo.id), true);
    assert.equal(remainingIds.includes(lvl3.id), true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sidebar conversation rows enforce uniform 42px height across groups and mixed native sections while keeping project tree children compact', () => {
  for (const codexTheme of [true, false]) {
    const { script } = buildClientScript({ codexTheme, zhUi: true });
    assert.match(script, /\.aq-grp-item\s*\{[\s\S]*?height:\s*42px;[\s\S]*?min-height:\s*42px;/);
    assert.match(
      script,
      /\.agy-sidebar-row:not\(\[class~="pl-\[30px\]"\]\):not\(\[class~="pl-2\.5"\]\)[\s\S]*?height:\s*42px\s*!important;/
    );
    assert.match(script, /\[data-sidebar-section-id="all"\]\s+\.agy-sidebar-row/);
    assert.match(script, /\[data-sidebar-section-id\^="status-"\]\s+\.agy-sidebar-row/);
    assert.match(script, /\[data-sidebar-section-id="standalone"\]\s+\.agy-sidebar-row/);
    assert.match(script, /is-no-project[\s\S]*?无项目/);
    assert.match(script, /\[data-subtext=""\]\[data-aq-no-project\]\s+\.flex-col::after/);
  }
});
