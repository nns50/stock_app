import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody, parseQuery } from './_helpers';
import { deletePreset, listPresets, savePreset, PresetKind } from '../db/presets';

export const presetsRouter = Router();

const KINDS = ['screener', 'option_entry', 'option_exit'] as const;

const listQuery = z.object({ kind: z.enum(KINDS).optional() });
presetsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { kind } = parseQuery(listQuery, req);
    res.json({ presets: listPresets(kind as PresetKind | undefined) });
  }),
);

const saveBody = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(KINDS),
  config: z.unknown(),
});
presetsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parseBody(saveBody, req);
    const preset = savePreset(body.name, body.kind as PresetKind, body.config);
    res.json(preset);
  }),
);

presetsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new HttpError(400, 'invalid id');
    if (!deletePreset(id)) throw new HttpError(404, 'preset not found');
    res.json({ deleted: id });
  }),
);
