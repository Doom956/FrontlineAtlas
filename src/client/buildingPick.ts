// Click areas around your buildings: as big as their marker on screen (plus a margin), so a building is easy to
// click at any zoom. Which building a click picks is the nearest one (selection.ts nearestOwnBuilding), so the
// click areas of two buildings never overlap.
import { FAR_ZOOM, markerSize } from './render/buildings';

/** Extra click margin (CSS px) around a building marker: mouse, and a finger on a touch screen. */
const BUILDING_PICK_PAD_PX = 8;
const BUILDING_PICK_TOUCH_PAD_PX = 16;

/**
 * Click radius around one of your buildings, in tiles, at this zoom: half the marker as drawn (render/buildings.ts,
 * the small dot when zoomed far out) plus a margin, so the area stays about the same size on screen at any zoom.
 * Which building a click picks is the nearest one (selection.ts nearestOwnBuilding): click areas never overlap.
 */
export function buildingPickTiles(zoom: number, touch: boolean): number {
  const marker = zoom >= FAR_ZOOM ? markerSize(zoom) : 2 * Math.min(4, Math.max(2, 1.5 + zoom * 0.7));
  return (marker / 2 + (touch ? BUILDING_PICK_TOUCH_PAD_PX : BUILDING_PICK_PAD_PX)) / zoom;
}
