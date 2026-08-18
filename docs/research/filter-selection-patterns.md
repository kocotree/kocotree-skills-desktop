# 筛选项单选 / 多选模式参考

调研日期：2026-08-13

目的：核实成熟设计系统如何表达“标签可多选”和“发布部门单选”，为 Kocotree Skills 广场的紧凑筛选区提供依据。以下只记录官方文档能够直接支持的行为，不把具体视觉方案包装成通用定论。

## 先说结论

- 没有一种胶囊外形天然等于多选或单选。Carbon 明确允许 selectable tag 同时承担单选和多选；Material 3 的 segmented button 也同时有 single-select 与 multi-select 两种模式。
- 最明确的传统语义仍然是：单选使用 radio，多选使用 checkbox。Shopify Polaris 和 Carbon 都明确这样区分。
- 如果追求当前页面所需的轻量视觉，可用“独立 filter chips（标签）+ 连成一组的 single-choice segmented control（部门）”。这不是靠某个小图标解释规则，而是通过两种不同的控件结构降低混淆。
- 但若两个组都继续画成几乎相同的独立胶囊，仅添加“可多选 / 单选”小字，仍需用户阅读或试错；官方资料不支持把这种外观本身视为足够明确。

## Shopify Polaris

### 官方行为

Shopify 的 Polaris ChoiceList 把一组相关选择呈现为 radio buttons 或 checkboxes。官方迁移文档说明，`multiple` 属性负责在单选与多选之间切换，并明确写出 `multiple=true` 时渲染 checkbox、`multiple=false` 时渲染 radio。

- [Shopify：Migrate to the Polaris choice list component](https://shopify.dev/docs/apps/build/customer-accounts/migrate-to-web-components/choice-list)
- [Shopify：App Home Choice list](https://shopify.dev/docs/api/app-home/web-components/forms/choice-list)
- [Shopify：ChoiceList API](https://shopify.dev/docs/api/pos-ui-extensions/2026-01/web-components/forms/choicelist)

ChoiceList 还提供 `list`、`inline`、`block`、`grid` 等布局变体，因此“横向排布”与“单选 / 多选语义”是两个独立维度；不能因为选项横向排列，就把 radio / checkbox 的选择语义抹掉。

### 对 Kocotree 的启发

- 如果必须做到零学习成本，标签应该具有 checkbox 语义，发布部门应该具有 radio 语义。
- 若觉得常驻方框和圆点太像表单，可把标准 ChoiceList 放进点击后展开的筛选浮层；收起状态只显示“标签 · 已选 2”“部门 · AI 部”等摘要。这样外层干净，展开后仍明确。
- 当前这种所有选项直接平铺的界面若继续采用胶囊，就需要额外用控件结构区分两组，而不应只依赖同形胶囊中的不同小图标。
- 部门未来增长到 4 个以上或横向空间不足时，可改用 [Shopify Select](https://shopify.dev/docs/api/app-home/web-components/forms/select)：该组件一次选择一个选项，官方把类别 / 状态以及选项较多或空间有限列为适用场景。

## Material Design

### Filter chips：适合多选筛选

Material 的 filter chip 官方文档把它描述为在紧凑空间展示筛选项的控件，并明确说明可以选中或取消多个 chip；选中时可以添加图标作为状态提示。它还允许多行换行。

- [Android Developers / Material 3：Chip / FilterChip](https://developer.android.com/develop/ui/compose/components/chip)

这与 Kocotree 的“标签”非常接近：标签是短文本、数量不多、需要快速组合条件，适合保持为彼此独立的 chips。选中态应主要依靠高对比的填充 / 文字色，勾可以只在选中时出现，不需要给每个未选项都放空方框。

### Segmented buttons：可表达少量并列选择，但外形本身不保证单选

Android 官方 Material 3 指南区分两种 segmented button：single-select 只选一个；multi-select 用于 2–5 个项目，更复杂或超过 5 个项目则建议用 chips。官方 API 也分别提供 `SingleChoiceSegmentedButtonRow` 与 `MultiChoiceSegmentedButtonRow`。

- [Android Developers / Material 3：Segmented button](https://developer.android.com/develop/ui/compose/components/segmented-button)

### 对 Kocotree 的启发

- 5 个左右的标签可用独立 filter chips；3 个部门可用 single-choice segmented row。这与官方建议的数量范围吻合。
- 部门项应共享一个连续外框或底板，形成“一个控件中的多个互斥段”；标签则彼此分离，形成“多个可独立开关的筛选条件”。
- segmented control 本身也可能支持多选，所以真正实现时还要保证单选行为、单一高亮状态和正确的 radio-group 无障碍语义，不能只改变 CSS 外观。

## IBM Carbon Design System

### 官方 filtering pattern

Carbon 的筛选模式指南直接把两类行为对应起来：single-selection filter 一次选择一个属性，行为类似 radio；multi-selection filter 能选择多个属性，行为类似 checkbox。前者可用 dropdown 或 radio set，后者可用 multiselect dropdown、inline multiselect 或 checkbox set。

- [Carbon：Filtering pattern](https://carbondesignsystem.com/patterns/filtering/)

Carbon 也要求隐藏的活动筛选条件仍有可见的已选数量与清除入口。这支持一种更可扩展的方案：当标签数量增加时，把标签放进弹层，但在外层持续显示“标签 2”及清除能力。

### Selectable tag

Carbon 把 selectable tag 定义为可选中 / 取消、可用于页面筛选的标签，并要求选中与未选中状态保持明显的高对比。它建议少量标签横向排列；超过约五行时改用 multi-select dropdown。

- [Carbon：Tag / Selectable tag](https://carbondesignsystem.com/components/tag/usage/)

值得注意的是，Carbon 明确表示 selectable tag 既可以用于多选，也可以用于单选。这再次说明：仅凭“胶囊标签”造型，用户无法可靠推断选择数量规则。

### Radio button

Carbon 对 radio 的规则非常直接：一组互斥选项中一次只能选择一个；选中新的选项会自动取消旧选项。如果可选择多个，应改用 checkbox。Carbon 也指出 radio 可以作为筛选机制。

- [Carbon：Radio button](https://carbondesignsystem.com/components/radio-button/usage/)

### 对 Kocotree 的启发

- 若保留 tags，选中 / 未选中的对比必须足够明显；浅灰边框和浅绿底差异过弱时，会让用户把选中态误认成 hover 或装饰。
- “标签用 tag、部门也用 tag”不会自然说明前者多选、后者单选。更合理的是换用不同结构，或让单选组保留标准 radio 线索。
- 当未来标签数量显著增长时，不宜无限换行；应升级为 multi-select dropdown / popover，并在触发器上显示已选数量或摘要。

## GitHub / Primer

### 官方行为

GitHub 的 Primer `ActionList` 在同一组件里并排给出了 single-select 与 multi-select 示例，但使用不同的选择语义：单选列表设置 `selectionVariant="single"` 并为选项使用 `role="menuitemradio"`；多选列表设置 `selectionVariant="multiple"` 并使用 `role="menuitemcheckbox"`。两种模式都会显示选中状态，但底层交互和无障碍角色明确不同。

- [Primer：ActionList（页面内含 Single-select / Multi-select 可交互示例）](https://primer.style/product/components/action-list/)
- [Primer：ActionMenu（页面内含单选与多选菜单示例）](https://primer.style/product/components/action-menu/)

GitHub Issues 当前产品把筛选集中在搜索 / 筛选体验中，官方帮助页将 Labels、Types 等作为不同筛选维度；GitHub 的公开 Issues 页面可直接查看现行体验。这个产品案例更值得借鉴的是“隐藏复杂选项、把已选条件留在查询中”，不是把所有筛选值永久铺满一行。

- [GitHub 当前 Issues 页面（可直接体验）](https://github.com/microsoft/vscode/issues)
- [GitHub Docs：Filtering and searching issues and pull requests](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests)

### 对 Kocotree 的启发

- 若标签和部门以后改进弹层，最稳妥的实现是复用同一种菜单容器，但让标签菜单呈现 checkbox/check 多选、部门菜单呈现 radio/check 单选。
- 外层触发器应该显示结果摘要，例如“标签 · 2”“部门 · AI 部”，而不是在收起时仍显示所有选项。
- Primer 的案例说明：即使视觉都用列表项与勾，单选 / 多选仍需在交互状态和 ARIA 角色上明确区分。

## Atlassian / Jira

### 官方行为

Atlassian Design System 直接提供了两种不同组件：`Checkbox select` 允许从选项列表中多选，`Radio select` 允许从选项列表中单选。这是“外层都用下拉选择器、展开后再用 checkbox / radio 说明基数”的典型做法。

- [Atlassian Design System：Checkbox select](https://atlassian.design/components/select/checkbox-select/)
- [Atlassian Design System：Radio select](https://atlassian.design/components/select/radio-select/)

Jira 当前官方帮助也展示了另一种产品级模式：点击页面顶部的 `Filter` 打开筛选面板，先选字段，再选该字段的值；选择时内容区即时更新，字段可固定在面板顶部，单个字段或全部筛选可以清除。Jira Board 的 assignee 筛选明确支持同时选择多人，说明其快速筛选不是默认把每个维度都当单选。

- [Jira Cloud：Manage filters in team-managed spaces](https://support.atlassian.com/jira-software-cloud/docs/manage-custom-filters-in-team-managed-projects/)
- [Jira Cloud：Show or hide work items on your board with quick filters](https://support.atlassian.com/jira-software-cloud/docs/show-or-hide-issues-on-your-board/)

### 对 Kocotree 的启发

- 想保持主页面干净时，可学习 Jira：把筛选项放进统一面板，字段标题和当前结果常驻，具体选项按需展开。
- 如果标签与部门各自使用下拉，展开后的 checkbox 与 radio 会比触发器旁写“多选 / 单选”更自然、更明确。
- 当前 Kocotree 只有 5 个标签、3 个部门，常驻展开仍合理；当选项增长时，Jira 式面板比继续横向堆 chips 更能扩展。

## Ant Design

### 官方行为

Ant Design 的 `Segmented` 官方定义就是“展示多个选项并允许用户选择其中单个选项”，适用于切换选项后关联区域内容变化；它把并列选项连成一个控件，并支持左右方向键切换。另一方面，`Select` 的 `mode="multiple"` 会显示多个已选值，默认在多选菜单项上使用勾图标；官方还建议少于 5 个选项的单选优先考虑 Radio。

- [Ant Design：Segmented（可直接体验多个单选示例）](https://ant.design/components/segmented/)
- [Ant Design：Select（可直接体验 Multiple selection）](https://ant.design/components/select/)
- [Ant Design：Radio](https://ant.design/components/radio/)

### 对 Kocotree 的启发

- 3 个部门很符合 `Segmented` 的条件：并列、互斥、切换后立即更新同一区域内容。
- 标签数量较少时，不必照搬多选 Select；独立 filter chips 能减少一次展开操作。标签变多后再升级为 multiple Select，并将已选值显示成可移除摘要。
- Ant Design 进一步支持当前推荐组合：部门用一个连体单选控件，标签用多个独立的可切换筛选项，两组不应保持完全相同的外观。

## 面向 Kocotree 的方案比较

| 方案 | 多选 / 单选可辨识度 | 视觉重量 | 适合当前页面 |
| --- | --- | --- | --- |
| 标签 checkbox + 部门 radio | 最高 | 偏重、像表单 | 适合强调零学习成本 |
| 独立 filter chips + 连体 single-select segmented control | 较高 | 轻 | **推荐用于当前 5 个标签 + 3 个部门** |
| 两组都用独立胶囊，仅加“可多选 / 单选”文字 | 中低 | 轻 | 不推荐作为最终方案 |
| 两组都收进筛选浮层，展开后用 checkbox / radio | 高 | 收起时最轻，但多一次点击 | 适合筛选项继续增加时 |

## 推荐落点

当前页面建议采用：

1. “标签”使用独立 filter chips；未选项不显示空 checkbox，已选项用明显填充色，可选配小勾。
2. “全部标签”是清除标签筛选的命令态，不与普通标签完全同义；不要让它与若干已选标签同时呈现为选中。
3. “发布部门”使用连体的单选分段控件，一次只保留一个高亮项；“全部”代表不限制部门。
4. 视觉上通过“分离 chips vs 连续 segmented group”建立差异；语义上分别使用 checkbox-group / radio-group 或等价的 ARIA 状态。
5. 不必再放灰底的“单选”徽章；“可多选”若保留，使用普通辅助文字即可。若可用性测试表明用户仍困惑，再考虑把标签移入带 checkbox 的弹层，而不是在每颗 chip 内常驻一个空方框。

## 建议优先打开看的页面

如果只想快速看视觉和交互，建议按这个顺序打开：

1. [Material FilterChip](https://developer.android.com/develop/ui/compose/components/chip)：最接近 Kocotree 的标签多选；未选项干净，选中时才出现勾和填充。
2. [Ant Design Segmented](https://ant.design/components/segmented/)：最接近 Kocotree 的 3 个部门单选。
3. [Primer ActionList](https://primer.style/product/components/action-list/)：同一页直接比较单选菜单和多选菜单。
4. [Shopify Choice list](https://shopify.dev/docs/api/app-home/web-components/forms/choice-list)：直接比较 radio 单选与 checkbox 多选的传统高辨识方案。
5. [GitHub Issues](https://github.com/microsoft/vscode/issues)：观察复杂产品如何把大量筛选项收进搜索 / 菜单，而非全部平铺。
