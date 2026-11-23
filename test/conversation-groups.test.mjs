import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

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

test('dragging items or folders from elsewhere into a target folder inserts at exact before/after child slot', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-external-insert-test-'));
  const filePath = path.join(tmpDir, 'conversation-groups.json');
  const CID_4 = '9d41bc22-55a1-49d0-a711-009988776655';

  try {
    const { group: targetGrp } = createConversationGroup(filePath, {
      name: '主力目录',
      initialItem: { cascadeId: CID_1, title: '会话一', project: 'proj-1' },
    });
    const { group: sourceGrp } = createConversationGroup(filePath, {
      name: '来源目录',
      initialItem: { cascadeId: CID_3, title: '会话三', project: 'proj-3' },
    });
    const { group: extFolder } = createConversationGroup(filePath, {
      name: '待迁入子目录',
    });

    // 1. External item dragged before single existing item CID_1 -> [CID_2, CID_1]
    let store = addConversationToGroup(filePath, {
      groupId: targetGrp.id,
      item: { cascadeId: CID_2, title: '会话二', project: 'proj-2' },
      beforeCascadeId: CID_1,
    });
    assert.deepEqual(
      store.groups.find((g) => g.id === targetGrp.id)?.childOrder,
      [`c:${CID_2}`, `c:${CID_1}`]
    );

    // 2. External folder dragged into targetGrp after CID_2 -> [CID_2, extFolder, CID_1]
    store = moveConversationGroup(filePath, {
      groupId: extFolder.id,
      parentId: targetGrp.id,
      afterCascadeId: CID_2,
    });
    assert.deepEqual(
      store.groups.find((g) => g.id === targetGrp.id)?.childOrder,
      [`c:${CID_2}`, `g:${extFolder.id}`, `c:${CID_1}`]
    );

    // 3. Cross-folder item CID_3 dragged from sourceGrp before subfolder extFolder -> [CID_2, CID_3, extFolder, CID_1]
    store = moveConversationBetweenGroups(filePath, {
      fromGroupId: sourceGrp.id,
      toGroupId: targetGrp.id,
      item: { cascadeId: CID_3, title: '会话三', project: 'proj-3' },
      beforeGroupId: extFolder.id,
    });
    assert.deepEqual(store.groups.find((g) => g.id === sourceGrp.id)?.items, []);
    assert.deepEqual(
      store.groups.find((g) => g.id === targetGrp.id)?.childOrder,
      [`c:${CID_2}`, `c:${CID_3}`, `g:${extFolder.id}`, `c:${CID_1}`]
    );

    // 4. External item CID_4 dragged after subfolder extFolder -> [CID_2, CID_3, extFolder, CID_4, CID_1]
    store = addConversationToGroup(filePath, {
      groupId: targetGrp.id,
      item: { cascadeId: CID_4, title: '会话四', project: 'proj-4' },
      afterGroupId: extFolder.id,
    });
    assert.deepEqual(
      store.groups.find((g) => g.id === targetGrp.id)?.childOrder,
      [`c:${CID_2}`, `c:${CID_3}`, `g:${extFolder.id}`, `c:${CID_4}`, `c:${CID_1}`]
    );

    // 5. Re-dragging already-grouped CID_1 from recent list before CID_2 moves it to top -> [CID_1, CID_2, CID_3, extFolder, CID_4]
    store = addConversationToGroup(filePath, {
      groupId: targetGrp.id,
      item: { cascadeId: CID_1, title: '会话一', project: 'proj-1' },
      beforeCascadeId: CID_2,
    });
    const finalTarget = store.groups.find((g) => g.id === targetGrp.id);
    assert.deepEqual(finalTarget?.childOrder, [
      `c:${CID_1}`,
      `c:${CID_2}`,
      `c:${CID_3}`,
      `g:${extFolder.id}`,
      `c:${CID_4}`,
    ]);
    assert.deepEqual(
      finalTarget?.items.map((it) => it.cascadeId),
      [CID_1, CID_2, CID_3, CID_4]
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('frontend pointer drag-and-drop resolves exact child before/after insertion for native-row, cross-folder item, and external folder', () => {
  const { script } = buildClientScript({ codexTheme: false, zhUi: false });

  function matchSingleCompound(el, compound) {
    let rest = compound.trim();
    if (!rest) return false;
    let neg = '';
    const notMatch = rest.match(/:not\(([^)]+)\)$/);
    if (notMatch) {
      neg = notMatch[1];
      rest = rest.slice(0, notMatch.index);
    }
    if (neg && matchSingleCompound(el, neg)) return false;

    const tagMatch = rest.match(/^[a-z0-9]+/i);
    if (tagMatch) {
      if (el.tagName !== tagMatch[0].toUpperCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    while (rest.length > 0) {
      if (rest.startsWith('#')) {
        const m = rest.match(/^#([a-z0-9_-]+)/i);
        if (!m || el.id !== m[1]) return false;
        rest = rest.slice(m[0].length);
      } else if (rest.startsWith('.')) {
        const m = rest.match(/^\.([a-z0-9_-]+)/i);
        if (!m || !el.classList.contains(m[1])) return false;
        rest = rest.slice(m[0].length);
      } else if (rest.startsWith('[')) {
        const mVal = rest.match(/^\[([a-z0-9_-]+)="([^"]*)"\]/i);
        if (mVal) {
          if (el.getAttribute(mVal[1]) !== mVal[2]) return false;
          rest = rest.slice(mVal[0].length);
        } else {
          const mHas = rest.match(/^\[([a-z0-9_-]+)\]/i);
          if (!mHas || !el.hasAttribute(mHas[1])) return false;
          rest = rest.slice(mHas[0].length);
        }
      } else {
        return false;
      }
    }
    return true;
  }

  function matchesSelectorFromScope(el, rawSel, scopeEl = null) {
    return rawSel
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((branch) => {
        let s = branch;
        let anchoredToScope = false;
        if (s.startsWith(':scope')) {
          anchoredToScope = true;
          s = s.slice(6).trim();
        }
        const tokens = [];
        let buf = '';
        let bracketDepth = 0;
        let parenDepth = 0;
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (ch === '[') bracketDepth++;
          else if (ch === ']') bracketDepth--;
          else if (ch === '(') parenDepth++;
          else if (ch === ')') parenDepth--;
          if (bracketDepth === 0 && parenDepth === 0 && (ch === '>' || /\s/.test(ch))) {
            if (buf) {
              tokens.push(buf);
              buf = '';
            }
            if (ch === '>') {
              if (tokens[tokens.length - 1] === ' ') tokens[tokens.length - 1] = '>';
              else tokens.push('>');
            } else if (
              tokens.length > 0 &&
              tokens[tokens.length - 1] !== '>' &&
              tokens[tokens.length - 1] !== ' '
            ) {
              tokens.push(' ');
            }
          } else {
            buf += ch;
          }
        }
        if (buf) tokens.push(buf);
        while (tokens[tokens.length - 1] === ' ') tokens.pop();

        if (anchoredToScope && tokens[0] === '>') {
          tokens.shift();
          const matchChainFrom = (idx, curEl) => {
            if (!matchSingleCompound(curEl, tokens[idx])) return false;
            if (idx === 0) return curEl.parentElement === scopeEl;
            const comb = tokens[idx - 1];
            if (comb === '>') {
              return curEl.parentElement ? matchChainFrom(idx - 2, curEl.parentElement) : false;
            }
            let anc = curEl.parentElement;
            while (anc && anc !== scopeEl) {
              if (matchChainFrom(idx - 2, anc)) return true;
              anc = anc.parentElement;
            }
            return false;
          };
          return tokens.length > 0 ? matchChainFrom(tokens.length - 1, el) : false;
        }

        const matchChain = (idx, curEl) => {
          if (!matchSingleCompound(curEl, tokens[idx])) return false;
          if (idx === 0) return true;
          const comb = tokens[idx - 1];
          if (comb === '>') {
            return curEl.parentElement ? matchChain(idx - 2, curEl.parentElement) : false;
          }
          let anc = curEl.parentElement;
          while (anc) {
            if (matchChain(idx - 2, anc)) return true;
            anc = anc.parentElement;
          }
          return false;
        };
        return tokens.length > 0 ? matchChain(tokens.length - 1, el) : false;
      });
  }

  function makeEl(tagName = 'div', rect = { left: 0, top: 0, right: 240, bottom: 40, width: 240, height: 40 }) {
    const attrs = new Map();
    const classes = new Set();
    const listeners = new Map();
    let box = { ...rect };
    const el = {
      tagName: String(tagName || 'div').toUpperCase(),
      id: '',
      className: '',
      textContent: '',
      innerHTML: '',
      style: {
        setProperty() {},
        removeProperty() {},
        getPropertyValue() {
          return '';
        },
      },
      dataset: {},
      children: [],
      parentElement: null,
      isConnected: true,
      scrollHeight: 0,
      clientHeight: 400,
      scrollTop: 0,
      setRect(next) {
        box = { ...next };
      },
      getBoundingClientRect() {
        return { ...box };
      },
      classList: {
        add: (...names) => names.forEach((n) => n && classes.add(n)),
        remove: (...names) => names.forEach((n) => classes.delete(n)),
        toggle: (n, force) => {
          const on = force === undefined ? !classes.has(n) : Boolean(force);
          if (on) classes.add(n);
          else classes.delete(n);
          return on;
        },
        contains: (n) => classes.has(n),
      },
      setAttribute(k, v) {
        const s = String(v);
        attrs.set(k, s);
        if (k === 'id') el.id = s;
        if (k === 'class') {
          classes.clear();
          s.split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        }
      },
      getAttribute(k) {
        return attrs.has(k) ? attrs.get(k) : null;
      },
      hasAttribute(k) {
        return attrs.has(k);
      },
      removeAttribute(k) {
        attrs.delete(k);
      },
      appendChild(child) {
        if (child.parentElement) child.remove();
        child.parentElement = el;
        el.children.push(child);
        return child;
      },
      insertBefore(node, refNode) {
        if (!refNode) return el.appendChild(node);
        if (node.parentElement) node.remove();
        node.parentElement = el;
        const idx = el.children.indexOf(refNode);
        if (idx === -1) el.children.push(node);
        else el.children.splice(idx, 0, node);
        return node;
      },
      prepend(...nodes) {
        const ref = el.children[0] || null;
        for (const n of nodes) el.insertBefore(n, ref);
      },
      remove() {
        if (!el.parentElement) return;
        const idx = el.parentElement.children.indexOf(el);
        if (idx !== -1) el.parentElement.children.splice(idx, 1);
        el.parentElement = null;
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      matches(sel) {
        return matchesSelectorFromScope(el, sel, null);
      },
      closest(sel) {
        let cur = el;
        while (cur) {
          if (matchesSelectorFromScope(cur, sel, null)) return cur;
          cur = cur.parentElement;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (node) => {
          for (const ch of node.children) {
            if (matchesSelectorFromScope(ch, sel, el)) out.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return out;
      },
      querySelector(sel) {
        return el.querySelectorAll(sel)[0] || null;
      },
    };
    return el;
  }

  const head = makeEl('head');
  const body = makeEl('body', { left: 0, top: 0, right: 1200, bottom: 900, width: 1200, height: 900 });
  const docEl = makeEl('html');
  docEl.appendChild(head);
  docEl.appendChild(body);

  // Build #aq-conv-groups DOM layout with exact bounding rects
  const panel = makeEl('div', { left: 10, top: 60, right: 250, bottom: 520, width: 240, height: 460 });
  panel.setAttribute('id', 'aq-conv-groups');
  panel.dataset.aqBound = '1';
  body.appendChild(panel);

  const topWrap = makeEl('div', { left: 10, top: 90, right: 250, bottom: 380, width: 240, height: 290 });
  topWrap.setAttribute('class', 'aq-grp-top-wrap');
  panel.appendChild(topWrap);

  const grpBody = makeEl('div', { left: 10, top: 90, right: 250, bottom: 380, width: 240, height: 290 });
  grpBody.setAttribute('class', 'aq-grp-body');
  topWrap.appendChild(grpBody);

  // Folder A (expanded, 1 item: CID_1)
  const blockA = makeEl('div', { left: 10, top: 100, right: 250, bottom: 172, width: 240, height: 72 });
  blockA.setAttribute('class', 'aq-grp-block');
  blockA.setAttribute('data-aq-grp-block', 'grp_a');
  blockA.setAttribute('data-aq-grp-depth', '0');
  grpBody.appendChild(blockA);

  const hdrA = makeEl('div', { left: 10, top: 100, right: 250, bottom: 128, width: 240, height: 28 });
  hdrA.setAttribute('class', 'aq-grp-hdr');
  hdrA.setAttribute('data-aq-grp-hdr', 'grp_a');
  blockA.appendChild(hdrA);

  const childrenA = makeEl('div', { left: 22, top: 130, right: 250, bottom: 172, width: 228, height: 42 });
  childrenA.setAttribute('class', 'aq-grp-children');
  blockA.appendChild(childrenA);

  const itemA1 = makeEl('div', { left: 22, top: 130, right: 250, bottom: 172, width: 228, height: 42 });
  itemA1.setAttribute('class', 'aq-grp-item');
  itemA1.setAttribute('data-aq-grp-open', CID_1);
  itemA1.setAttribute('data-aq-grp-gid', 'grp_a');
  childrenA.appendChild(itemA1);

  // Folder B (expanded, mixed: CID_2 + collapsed subfolder grp_sub_b1)
  const blockB = makeEl('div', { left: 10, top: 180, right: 250, bottom: 281, width: 240, height: 101 });
  blockB.setAttribute('class', 'aq-grp-block');
  blockB.setAttribute('data-aq-grp-block', 'grp_b');
  blockB.setAttribute('data-aq-grp-depth', '0');
  grpBody.appendChild(blockB);

  const hdrB = makeEl('div', { left: 10, top: 180, right: 250, bottom: 208, width: 240, height: 28 });
  hdrB.setAttribute('class', 'aq-grp-hdr');
  hdrB.setAttribute('data-aq-grp-hdr', 'grp_b');
  blockB.appendChild(hdrB);

  const childrenB = makeEl('div', { left: 22, top: 210, right: 250, bottom: 281, width: 228, height: 71 });
  childrenB.setAttribute('class', 'aq-grp-children');
  blockB.appendChild(childrenB);

  const itemB1 = makeEl('div', { left: 22, top: 210, right: 250, bottom: 252, width: 228, height: 42 });
  itemB1.setAttribute('class', 'aq-grp-item');
  itemB1.setAttribute('data-aq-grp-open', CID_2);
  itemB1.setAttribute('data-aq-grp-gid', 'grp_b');
  childrenB.appendChild(itemB1);

  const subB1 = makeEl('div', { left: 22, top: 253, right: 250, bottom: 281, width: 228, height: 28 });
  subB1.setAttribute('class', 'aq-grp-block');
  subB1.setAttribute('data-aq-grp-block', 'grp_sub_b1');
  subB1.setAttribute('data-aq-grp-depth', '1');
  childrenB.appendChild(subB1);

  const hdrSubB1 = makeEl('div', { left: 22, top: 253, right: 250, bottom: 281, width: 228, height: 28 });
  hdrSubB1.setAttribute('class', 'aq-grp-hdr');
  hdrSubB1.setAttribute('data-aq-grp-hdr', 'grp_sub_b1');
  subB1.appendChild(hdrSubB1);

  // Folder C (collapsed)
  const blockC = makeEl('div', { left: 10, top: 290, right: 250, bottom: 318, width: 240, height: 28 });
  blockC.setAttribute('class', 'aq-grp-block');
  blockC.setAttribute('data-aq-grp-block', 'grp_c');
  blockC.setAttribute('data-aq-grp-depth', '0');
  grpBody.appendChild(blockC);

  const hdrC = makeEl('div', { left: 10, top: 290, right: 250, bottom: 318, width: 240, height: 28 });
  hdrC.setAttribute('class', 'aq-grp-hdr');
  hdrC.setAttribute('data-aq-grp-hdr', 'grp_c');
  blockC.appendChild(hdrC);

  // Recent conversation row inside #aq-conv-groups (triggers mode === 'native-row')
  const recentItem = makeEl('div', { left: 10, top: 410, right: 250, bottom: 452, width: 240, height: 42 });
  recentItem.setAttribute('class', 'aq-grp-item');
  recentItem.setAttribute('data-aq-grp-open', CID_3);
  recentItem.setAttribute('data-aq-project', 'proj-ext');
  const recentTitle = makeEl('span');
  recentTitle.setAttribute('class', 'aq-grp-item-title');
  recentTitle.textContent = '外部会话三';
  recentItem.appendChild(recentTitle);
  panel.appendChild(recentItem);

  const docListeners = new Map();
  const winListeners = new Map();
  const groupActions = [];

  const documentObj = {
    head,
    body,
    documentElement: docEl,
    hidden: false,
    createElement: (tag) => makeEl(tag),
    getElementById: (id) => docEl.querySelector(`#${id}`),
    querySelector: (sel) => docEl.querySelector(sel),
    querySelectorAll: (sel) => docEl.querySelectorAll(sel),
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener: () => {},
  };

  let nextRafId = 1;
  const rafQueue = new Map();
  const flushRaf = () => {
    const entries = [...rafQueue.entries()];
    rafQueue.clear();
    for (const [, cb] of entries) cb();
  };

  const windowObj = {
    document: documentObj,
    innerWidth: 1200,
    innerHeight: 900,
    location: { href: 'https://antigravity.local/' },
    navigator: { clipboard: { writeText: async () => {} } },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    PointerEvent: class {
      constructor(type, init = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    requestAnimationFrame: (cb) => {
      const id = nextRafId++;
      rafQueue.set(id, cb);
      return id;
    },
    cancelAnimationFrame: (id) => {
      rafQueue.delete(id);
    },
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatchEvent() {},
    __aqGroupAction(rawJson) {
      groupActions.push(JSON.parse(rawJson));
    },
  };
  windowObj.window = windowObj;
  windowObj.top = windowObj;
  windowObj.globalThis = windowObj;
  windowObj.__APP_CONFIG__ = { productName: 'antigravity' };
  windowObj.history = { pushState() {}, replaceState() {} };

  vm.runInNewContext(script, windowObj);

  const resetGroupsState = () => {
    windowObj.__aqRenderGroups({
      collapsedSection: false,
      groups: [
        {
          id: 'grp_a',
          name: '文件夹A',
          parentId: '',
          collapsed: false,
          items: [{ cascadeId: CID_1, title: '会话一', project: 'proj-1' }],
          childOrder: [`c:${CID_1}`],
        },
        {
          id: 'grp_b',
          name: '文件夹B',
          parentId: '',
          collapsed: false,
          items: [{ cascadeId: CID_2, title: '会话二', project: 'proj-2' }],
          childOrder: [`c:${CID_2}`, 'g:grp_sub_b1'],
        },
        {
          id: 'grp_sub_b1',
          name: '子文件夹B1',
          parentId: 'grp_b',
          collapsed: true,
          items: [],
          childOrder: [],
        },
        {
          id: 'grp_c',
          name: '折叠文件夹C',
          parentId: '',
          collapsed: true,
          items: [{ cascadeId: CID_1, title: '会话一', project: 'proj-1' }],
          childOrder: [`c:${CID_1}`],
        },
      ],
    });
  };

  const firePointer = (type, extra) => {
    const fns = (type === 'pointerdown' ? docListeners : winListeners).get(type) || [];
    const ev = {
      type,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      isPrimary: true,
      preventDefault: () => {},
      stopPropagation: () => {},
      stopImmediatePropagation: () => {},
      ...extra,
    };
    for (const fn of fns) fn(ev);
    if (type === 'pointermove') flushRaf();
  };

  // Case 1: Drag external native-row (CID_3) onto top half of single item CID_1 in Folder A (y = 140)
  resetGroupsState();
  groupActions.length = 0;
  firePointer('pointerdown', { target: recentItem, clientX: 80, clientY: 430 });
  firePointer('pointermove', { target: itemA1, clientX: 80, clientY: 140 });
  assert.equal(itemA1.classList.contains('aq-grp-item-drag-before'), true);
  assert.equal(blockA.classList.contains('aq-grp-drop-target'), false);
  firePointer('pointerup', { target: itemA1, clientX: 80, clientY: 140 });
  assert.equal(groupActions.length, 1);
  assert.equal(groupActions[0].type, 'add-item');
  assert.equal(groupActions[0].groupId, 'grp_a');
  assert.equal(groupActions[0].item.cascadeId, CID_3);
  assert.equal(groupActions[0].beforeCascadeId, CID_1);

  // Case 2: Drag group-item (CID_1 from Folder A) onto top 20% of collapsed subfolder grp_sub_b1 inside Folder B (y = 258)
  resetGroupsState();
  groupActions.length = 0;
  firePointer('pointerdown', { target: itemA1, clientX: 80, clientY: 150 });
  firePointer('pointermove', { target: hdrSubB1, clientX: 80, clientY: 258 });
  assert.equal(subB1.classList.contains('aq-grp-drag-before'), true);
  firePointer('pointerup', { target: hdrSubB1, clientX: 80, clientY: 258 });
  assert.equal(groupActions.length, 1);
  assert.equal(groupActions[0].type, 'move-item');
  assert.equal(groupActions[0].fromGroupId, 'grp_a');
  assert.equal(groupActions[0].toGroupId, 'grp_b');
  assert.equal(groupActions[0].beforeGroupId, 'grp_sub_b1');

  // Case 3: Drag group-item (CID_1 from Folder A) onto bottom half of CID_2 inside Folder B (y = 242)
  resetGroupsState();
  groupActions.length = 0;
  firePointer('pointerdown', { target: itemA1, clientX: 80, clientY: 150 });
  firePointer('pointermove', { target: itemB1, clientX: 80, clientY: 242 });
  assert.equal(itemB1.classList.contains('aq-grp-item-drag-after'), true);
  firePointer('pointerup', { target: itemB1, clientX: 80, clientY: 242 });
  assert.equal(groupActions.length, 1);
  assert.equal(groupActions[0].type, 'move-item');
  assert.equal(groupActions[0].fromGroupId, 'grp_a');
  assert.equal(groupActions[0].toGroupId, 'grp_b');
  assert.equal(groupActions[0].afterCascadeId, CID_2);

  // Case 4: Drag external root folder (Folder A) onto top half of CID_2 inside expanded Folder B (y = 220)
  resetGroupsState();
  groupActions.length = 0;
  firePointer('pointerdown', { target: hdrA, clientX: 80, clientY: 114 });
  firePointer('pointermove', { target: itemB1, clientX: 80, clientY: 220 });
  assert.equal(itemB1.classList.contains('aq-grp-item-drag-before'), true);
  firePointer('pointerup', { target: itemB1, clientX: 80, clientY: 220 });
  assert.equal(groupActions.length, 1);
  assert.equal(groupActions[0].type, 'move-group');
  assert.equal(groupActions[0].groupId, 'grp_a');
  assert.equal(groupActions[0].parentId, 'grp_b');
  assert.equal(groupActions[0].beforeCascadeId, CID_2);

  // Case 5: Drag external native-row (CID_3) onto collapsed Folder C header (y = 304) still highlights folder and appends
  resetGroupsState();
  groupActions.length = 0;
  firePointer('pointerdown', { target: recentItem, clientX: 80, clientY: 430 });
  firePointer('pointermove', { target: hdrC, clientX: 80, clientY: 304 });
  assert.equal(blockC.classList.contains('aq-grp-drop-target'), true);
  firePointer('pointerup', { target: hdrC, clientX: 80, clientY: 304 });
  assert.equal(groupActions.length, 1);
  assert.equal(groupActions[0].type, 'add-item');
  assert.equal(groupActions[0].groupId, 'grp_c');
  assert.equal('beforeCascadeId' in groupActions[0], false);
  assert.equal('afterCascadeId' in groupActions[0], false);

  // Case 6: Dragging native-row that ALREADY exists in Folder A directly over its own row does not light up folder drop-target
  resetGroupsState();
  groupActions.length = 0;
  recentItem.setAttribute('data-aq-grp-open', CID_1);
  firePointer('pointerdown', { target: recentItem, clientX: 80, clientY: 430 });
  firePointer('pointermove', { target: itemA1, clientX: 80, clientY: 150 });
  assert.equal(blockA.classList.contains('aq-grp-drop-target'), false);
  assert.equal(itemA1.classList.contains('aq-grp-item-drag-before'), false);
  assert.equal(itemA1.classList.contains('aq-grp-item-drag-after'), false);
  firePointer('pointerup', { target: itemA1, clientX: 80, clientY: 150 });
  assert.equal(groupActions.length, 0);

  windowObj.__aqCleanup();
});
