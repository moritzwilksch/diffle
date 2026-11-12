// Which side of a comparison a line is on. Its own module so `protocol.ts` and `tour.ts`, which
// imports nothing from `protocol.ts`, share it.
import { z } from 'zod';

export const SideSchema = z.enum(['old', 'new']);
export type Side = z.infer<typeof SideSchema>;
