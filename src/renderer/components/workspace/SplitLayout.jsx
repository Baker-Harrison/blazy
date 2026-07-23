import { Fragment, memo } from 'react';
import { Panel, Group, Separator } from 'react-resizable-panels';
import PaneContainer from './PaneContainer';

// This component draws the tabs/panes of a workspace, and supports the app's
// "split view" feature — the ability to divide the window into multiple
// resizable sections, side-by-side or stacked, similar to splitting a
// window in VS Code or a browser. It works recursively: a "split" can itself
// contain more splits nested inside it, which is what lets you build
// arbitrarily complex grid-like layouts (e.g. one editor on the left, and a
// terminal stacked above a browser on the right).
//
// We wrap this component in `memo` so React only re-evaluates a split branch
// when its specific layout node or workspace props actually change, avoiding
// wasteful redraws across unrelated parts of the split tree.
const SplitLayout = memo(function SplitLayout({ node, workspace }) {
  // Nothing to draw if there's no layout defined yet.
  if (!node) return null;

  // Base case of the recursion: a single pane with no further splitting —
  // just render its actual content (browser, terminal, or editor).
  if (node.type === 'pane') {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <PaneContainer pane={node} workspace={workspace} />
      </div>
    );
  }

  // Otherwise, this node represents a split with two or more children
  // arranged side-by-side (direction "horizontal") or stacked (direction
  // "vertical"). "sizes" remembers how big each section should be, as
  // percentages of the total (e.g. [30, 70] means the first section takes
  // 30% of the space and the second takes 70%).
  const { direction, children, sizes } = node;
  const count = children.length;
  // If we don't have valid saved sizes (e.g. this is a brand new split),
  // just divide the space evenly between every child instead.
  const defaultSizes = Array.isArray(sizes) && sizes.length === count
    ? sizes
    : Array(count).fill(100 / count);

  // The panel library wants sizes as an object keyed by each panel's id,
  // rather than a plain ordered list — so build that mapping here.
  const defaultLayout = Object.fromEntries(
    children.map((child, index) => [child.id, defaultSizes[index]])
  );

  // Called whenever the user drags a divider to resize sections. We convert
  // the library's layout object back into our own ordered list of sizes and
  // save it, so the split stays the same size the next time you open it.
  const handleLayout = (layout) => {
    const nextSizes = children.map((child) => layout[child.id] ?? 100 / count);
    workspace.resizeSplit(node.id, nextSizes);
  };

  return (
    <Group
      orientation={direction}
      className="h-full min-h-0 min-w-0 flex-1 bg-app"
      defaultLayout={defaultLayout}
      onLayoutChanged={handleLayout}
    >
      {/* Draw one resizable Panel per child, with a thin draggable
          Separator (divider line) between each pair of panels so the user
          can drag to resize them. Each child panel recursively renders
          SplitLayout again — so if a child is itself a further split, it
          keeps subdividing correctly. */}
      {children.map((child, index) => (
        <Fragment key={child.id}>
          {index > 0 && (
            <Separator className="pane-separator" />
          )}
          <Panel
            id={child.id}
            defaultSize={defaultSizes[index]}
            minSize={10}
            className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
          >
            <SplitLayout node={child} workspace={workspace} />
          </Panel>
        </Fragment>
      ))}
    </Group>
  );
});

export default SplitLayout;
