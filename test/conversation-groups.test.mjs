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
  reorderConversationGroupItems,
  reorderConversationGroups,
  syncConversationMetadata,
  toggleConversationGroupCollapse,
  writeConversationGroupsStore,
} from '../src/conversation-groups.mjs';
import { buildClientScript } from '../src/daemon.mjs';

const CID_1 = '8866de7d-15be-40b5-9a89-ece7bdc73e24';
const CID_2 = '6eca6d45-0e6c-4724-bf7a-867c2f82ca4a';
const CID_3 = '3b12f9a4-7c01-4d8e-8912-15ab34cd56ef';

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

    // Add duplicate updates metadata without duplicating item; new item appends at bottom
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
      [CID_1, CID_2]
    );

    // Re-adding CID_1 updates metadata while keeping its sorted position at index 0
    store = addConversationToGroup(filePath, {
      groupId: g1.id,
      item: { cascadeId: CID_1, title: '订阅修复 v3', project: 'antigravity-quota-injector' },
    });
    assert.deepEqual(
      store.groups[0].items.map((it) => it.cascadeId),
      [CID_1, CID_2]
    );
    assert.equal(store.groups[0].items[0].title, '订阅修复 v3');

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
    assert.equal(syncHit.store.groups[1].items[1].title, '电脑磁盘空间清理建议');

    // Move item between groups (removes from source, appends to bottom of target, expands collapsed)
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

    // Move back to g1: newly moved-in item is placed at the bottom of g1 ([CID_1, CID_2])
    store = moveConversationBetweenGroups(filePath, {
      fromGroupId: g2.id,
      toGroupId: g1.id,
      item: { cascadeId: CID_2, title: '电脑磁盘空间清理建议', project: 'EcoPaste' },
    });
    assert.deepEqual(store.groups[0].items, []);
    assert.deepEqual(
      store.groups[1].items.map((it) => it.cascadeId),
      [CID_1, CID_2]
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
    assert.match(script, /\.aq-grp-item\.aq-grp-item-drag-before::before/);
    assert.match(script, /\.aq-grp-item\.aq-grp-item-drag-after::after/);
    assert.match(script, /type:\s*'reorder-items'/);
    assert.match(script, /data-aq-grp-count/);
  }
});

test('mixed childOrder supports interleaving subfolders and conversations, bottom-append on new items/subfolders, and legacy store normalization', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-mixed-order-test-'));
  const filePath = path.join(tmpDir, 'conversation-groups.json');

  try {
    const { group: root } = createConversationGroup(filePath, {
      name: '工作台',
      initialItem: { cascadeId: CID_1, title: '会话一', project: 'proj-a' },
    });

    // Newly created subfolder appends to bottom after CID_1
    const { group: sub1, store: sAfterSub1 } = createConversationGroup(filePath, {
      name: '子目录A',
      parentId: root.id,
    });
    assert.deepEqual(
      sAfterSub1.groups.find((g) => g.id === root.id)?.childOrder,
      [`c:${CID_1}`, `g:${sub1.id}`]
    );

    // Newly added conversation appends to bottom after sub1
    let store = addConversationToGroup(filePath, {
      groupId: root.id,
      item: { cascadeId: CID_2, title: '会话二', project: 'proj-b' },
    });
    assert.deepEqual(
      store.groups.find((g) => g.id === root.id)?.childOrder,
      [`c:${CID_1}`, `g:${sub1.id}`, `c:${CID_2}`]
    );

    // Drag conversation CID_2 before subfolder sub1 -> [CID_1, CID_2, sub1]
    store = reorderConversationGroupItems(filePath, {
      groupId: root.id,
      cascadeId: CID_2,
      beforeGroupId: sub1.id,
    });
    assert.deepEqual(
      store.groups.find((g) => g.id === root.id)?.childOrder,
      [`c:${CID_1}`, `c:${CID_2}`, `g:${sub1.id}`]
    );

    // Drag subfolder sub1 before conversation CID_1 -> [sub1, CID_1, CID_2]
    store = moveConversationGroup(filePath, {
      groupId: sub1.id,
      parentId: root.id,
      beforeCascadeId: CID_1,
    });
    assert.deepEqual(
      store.groups.find((g) => g.id === root.id)?.childOrder,
      [`g:${sub1.id}`, `c:${CID_1}`, `c:${CID_2}`]
    );

    // Drag external root folder into root: newly dragged-in subfolder lands at the very bottom
    const { group: extFolder } = createConversationGroup(filePath, { name: '外部文件夹' });
    store = moveConversationGroup(filePath, {
      groupId: extFolder.id,
      parentId: root.id,
    });
    assert.deepEqual(
      store.groups.find((g) => g.id === root.id)?.childOrder,
      [`g:${sub1.id}`, `c:${CID_1}`, `c:${CID_2}`, `g:${extFolder.id}`]
    );

    // Drag conversation CID_1 after extFolder -> [sub1, CID_2, extFolder, CID_1]
    store = reorderConversationGroupItems(filePath, {
      groupId: root.id,
      cascadeId: CID_1,
      afterGroupId: extFolder.id,
    });
    const updatedRoot = store.groups.find((g) => g.id === root.id);
    assert.deepEqual(updatedRoot?.childOrder, [
      `g:${sub1.id}`,
      `c:${CID_2}`,
      `g:${extFolder.id}`,
      `c:${CID_1}`,
    ]);
    assert.deepEqual(
      updatedRoot?.items.map((it) => it.cascadeId),
      [CID_2, CID_1]
    );

    // Regression: when parent sits between its children in flat groups array ([subA, parent, subB]),
    // normalizing must still sync grandchild order inside subB without skipping subB
    const nestedRaw = {
      version: 1,
      collapsedSection: false,
      groups: [
        { id: 'grp_sub_a', name: '子A', parentId: 'grp_parent', collapsed: false, items: [] },
        {
          id: 'grp_parent',
          name: '父目录',
          parentId: '',
          collapsed: false,
          items: [],
          childOrder: ['g:grp_sub_b', 'g:grp_sub_a'],
        },
        {
          id: 'grp_sub_b',
          name: '子B',
          parentId: 'grp_parent',
          collapsed: false,
          items: [],
          childOrder: ['g:grp_grand_2', 'g:grp_grand_1'],
        },
        { id: 'grp_grand_1', name: '孙1', parentId: 'grp_sub_b', collapsed: false, items: [] },
        { id: 'grp_grand_2', name: '孙2', parentId: 'grp_sub_b', collapsed: false, items: [] },
      ],
    };
    const normalizedNested = writeConversationGroupsStore(filePath, nestedRaw);
    assert.deepEqual(
      normalizedNested.groups.filter((g) => g.parentId === 'grp_parent').map((g) => g.id),
      ['grp_sub_b', 'grp_sub_a']
    );
    assert.deepEqual(
      normalizedNested.groups.filter((g) => g.parentId === 'grp_sub_b').map((g) => g.id),
      ['grp_grand_2', 'grp_grand_1']
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('folder item drag-sort supports before/after anchors, orderedCascadeIds, and appends newly dragged-in items at bottom', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-item-sort-test-'));
  const filePath = path.join(tmpDir, 'conversation-groups.json');

  try {
    const { group: folderA } = createConversationGroup(filePath, {
      name: '常用会话',
      initialItem: { cascadeId: CID_1, title: '会话一', project: 'proj-a' },
    });
    const { group: folderB } = createConversationGroup(filePath, {
      name: '次要会话',
    });

    // Newly dragged-in items append to bottom in order: CID_1 -> CID_2 -> CID_3
    addConversationToGroup(filePath, {
      groupId: folderA.id,
      item: { cascadeId: CID_2, title: '会话二', project: 'proj-b' },
    });
    let store = addConversationToGroup(filePath, {
      groupId: folderA.id,
      item: { cascadeId: CID_3, title: '会话三', project: 'proj-c' },
    });
    assert.deepEqual(
      store.groups[0].items.map((it) => it.cascadeId),
      [CID_1, CID_2, CID_3]
    );

    // Drag CID_3 before CID_1 -> [CID_3, CID_1, CID_2]
    store = reorderConversationGroupItems(filePath, {
      groupId: folderA.id,
      cascadeId: CID_3,
      beforeCascadeId: CID_1,
    });
    assert.deepEqual(
      store.groups[0].items.map((it) => it.cascadeId),
      [CID_3, CID_1, CID_2]
    );

    // Drag CID_3 after CID_1 -> [CID_1, CID_3, CID_2]
    store = reorderConversationGroupItems(filePath, {
      groupId: folderA.id,
      cascadeId: CID_3,
      afterCascadeId: CID_1,
    });
    assert.deepEqual(
      store.groups[0].items.map((it) => it.cascadeId),
      [CID_1, CID_3, CID_2]
    );

    // Explicit orderedCascadeIds -> [CID_2, CID_1, CID_3]
    store = reorderConversationGroupItems(filePath, {
      groupId: folderA.id,
      orderedCascadeIds: [CID_2, CID_1, CID_3],
    });
    assert.deepEqual(
      store.groups[0].items.map((it) => it.cascadeId),
      [CID_2, CID_1, CID_3]
    );

    // Moving items into folderB places each newly dragged-in item at the bottom of folderB
    moveConversationBetweenGroups(filePath, {
      fromGroupId: folderA.id,
      toGroupId: folderB.id,
      item: { cascadeId: CID_2, title: '会话二', project: 'proj-b' },
    });
    store = moveConversationBetweenGroups(filePath, {
      fromGroupId: folderA.id,
      toGroupId: folderB.id,
      item: { cascadeId: CID_3, title: '会话三', project: 'proj-c' },
    });
    assert.deepEqual(
      store.groups[0].items.map((it) => it.cascadeId),
      [CID_1]
    );
    assert.deepEqual(
      store.groups[1].items.map((it) => it.cascadeId),
      [CID_2, CID_3]
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
