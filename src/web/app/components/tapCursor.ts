import type uPlot from 'uplot';

/**
 * On a touch screen, a tap shows the values there until a tap anywhere else, as pointing with a mouse does. Some
 * browsers say the mouse left the chart straight after a tap, which would hide them at once: that's ignored until a
 * mouse moves on the chart again. Returns the clean-up.
 */
export function keepTappedValues(chart: uPlot): () => void {
  const over = chart.over;
  let touch = false;
  const onPointer = (e: PointerEvent) => {
    touch = e.pointerType !== 'mouse';
  };
  // Before uPlot's own listener on the plot, which hides the values.
  const onLeave = (e: MouseEvent) => {
    if (touch && e.target === over) e.stopPropagation();
  };
  const onDownElsewhere = (e: PointerEvent) => {
    if (!touch || (e.target instanceof Node && over.contains(e.target))) return;
    if ((chart.cursor.left ?? -1) >= 0) chart.setCursor({ left: -10, top: -10 });
  };
  over.addEventListener('pointerdown', onPointer);
  over.addEventListener('pointermove', onPointer);
  chart.root.addEventListener('mouseleave', onLeave, true);
  document.addEventListener('pointerdown', onDownElsewhere, true);
  return () => {
    over.removeEventListener('pointerdown', onPointer);
    over.removeEventListener('pointermove', onPointer);
    chart.root.removeEventListener('mouseleave', onLeave, true);
    document.removeEventListener('pointerdown', onDownElsewhere, true);
  };
}
