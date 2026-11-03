<script module lang="ts">
  // Open modals in render order: the last token is top-most and the only
  // one that responds to Escape and Tab. Z-index stacking comes from plain
  // DOM order (each later modal paints above the earlier one).
  const stack: symbol[] = [];
</script>

<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    title,
    onClose,
    contentClass = "",
    closeOnBackdrop = true,
    children,
  }: {
    title: string;
    onClose: () => void;
    contentClass?: string;
    closeOnBackdrop?: boolean;
    children?: Snippet;
  } = $props();

  let content = $state<HTMLDivElement>();

  // Unique per-instance token; the module-level stack only needs identity.
  const token = Symbol();

  $effect(() => {
    stack.push(token);
    const prevFocus = document.activeElement as HTMLElement | null;

    const first = content?.querySelector<HTMLElement>("a[href], button, input, select, textarea");
    if (first) first.focus();

    return () => {
      const i = stack.indexOf(token);
      if (i !== -1) stack.splice(i, 1);
      // Restore focus to the element the invoker had before opening.
      if (prevFocus && prevFocus.isConnected) prevFocus.focus();
    };
  });

  function trapTab(e: KeyboardEvent): void {
    if (!content) return;
    const items = Array.from(
      content.querySelectorAll<HTMLElement>(
        "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !content.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !content.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  export function isTop(): boolean {
    return stack[stack.length - 1] === token;
  }

  function onWindowKeydown(e: KeyboardEvent): void {
    // Only the top-most modal reacts to keys: a lower modal must not steal
    // Tab focus back from the modal above it.
    if (!isTop()) return;
    if (e.key === "Tab") trapTab(e);
    if (e.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="modal-overlay"
  role="presentation"
  onclick={(e) => closeOnBackdrop && e.target === e.currentTarget && onClose()}
>
  <div class="modal-content {contentClass}" bind:this={content} role="dialog" aria-modal="true">
    <h3>{title}</h3>
    {@render children?.()}
  </div>
</div>
