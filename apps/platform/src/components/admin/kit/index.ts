/**
 * The admin component kit. Every admin page builds from these so the console looks and works the same
 * everywhere. See docs/admin-ui.md for the rules and /admin/kit for a live gallery.
 */
export { Button, IconButton, buttonVariants } from "./button"
export { Badge, ToneText, type Tone } from "./badge"
export { PageHeader, Panel, PanelHeader, PanelBody, PanelFooter, SplitLayout, Stat, StatRow, EmptyState } from "./surface"
export { Input, Textarea, Select, MoneyInput, Field, FieldGrid, FormSection, CheckboxField, SwitchField, FormActions } from "./form"
export { SearchInput, Segmented, FilterMenu, Toolbar, type SegmentOption } from "./filters"
export { Table, THead, TH, TR, TD, CellStack, TableFooter, DataTable, type Column } from "./table"
export { RowMenu, RowActions, type RowMenuItem } from "./row-actions"
export { Dialog, Sheet, ConfirmProvider, useConfirm, usePrompt, type ConfirmOptions, type PromptOptions } from "./dialog"
export { Tabs, TabsList, TabsTrigger, TabsContent, Notice, Pager, JsonView, DetailList } from "./misc"
export { UserPicker, UserMultiPicker, type AdminUserOption } from "./user-picker"
