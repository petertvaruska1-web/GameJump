// Anchor positions shared between map sections so routes join up exactly.
// Convention: +Z is "forward" (toward the finish). From the start, LEFT is +X
// and RIGHT is -X.
//
//                          SPIRE (finish)
//                 elevator /           \ broken stairway
//                         FOOTHILLS
//                   zip lines ||  (relay mast)
//                       CABLE STATION (launch pads up)
//                         LAUNCH YARD
//          assembly line /            \ laser galleries
//                        RING (merge, reactor core)
//      hangar/gardens     |  viaduct     \  antenna array -> leap of faith
//      foundry            |  gantry  <--- crane jib shortcut
//      scaffold yard      |  plaza        rooftops / smokestacks
//          \______________ START ______________/

export const START = { x: 0, y: 40, z: 0, w: 24, d: 20 };

// Centre route
export const PLAZA = { x: 0, y: 36, w: 30, d: 30 };
export const GANTRY = { x: 0, y: 38, z: 160, w: 20, d: 24 };
export const VIADUCT_Z0 = 204;

// Merge
export const RING = { x: 0, y: 44, z: 540, R: 28, width: 7, segments: 8 };
export const RING_SIDE = 2 * RING.R * Math.tan(Math.PI / RING.segments) + 0.6;
export const RING_OUTER = RING.R + RING.width / 2;
export const RING_INNER = RING.R - RING.width / 2;

// Upper Works (after the ring)
/** North Junction platform centre (10 x 9) right off the ring's north segment. */
export const NJ = { y: RING.y, z: RING.z + RING_OUTER + 4.5 };
export const YARD = { y: 48, z0: 684, z1: 704, w: 46 };
export const STATION = { y: 76, z0: 718, z1: 738, w: 22 };
export const FOOT = { y: 56, z0: 836, z1: 850, w: 32 };
export const SPIRE = { x: 0, y: FOOT.y + 20, z: FOOT.z1 + 66.5, size: 22 };

// Left route (+X)
export const L1 = { x: 48, y: 34, w: 22, d: 26 };
export const FOUNDRY = { x: 56, y: 40, w: 24, d: 40, h: 8 };
export const HANGAR = { x: 52, y: 36, w: 28, d: 40, h: 10 };

// Right route (-X)
export const R1 = { x: -44, y: 41.5, z: 72, w: 16, d: 16 };
