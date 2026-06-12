import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, param, parseBody } from './_helpers';
import { deleteSetting, getAllSettings, getSetting, setSetting } from '../db/settings';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  res.json(getAllSettings());
});

settingsRouter.get(
  '/:key',
  asyncHandler(async (req, res) => {
    const value = getSetting(param(req, 'key'));
    if (value === undefined) throw new HttpError(404, 'setting not found');
    res.json({ key: param(req, 'key'), value });
  }),
);

const putBody = z.object({ value: z.unknown() });
settingsRouter.put(
  '/:key',
  asyncHandler(async (req, res) => {
    const { value } = parseBody(putBody, req);
    setSetting(param(req, 'key'), value);
    res.json({ key: param(req, 'key'), value });
  }),
);

settingsRouter.delete(
  '/:key',
  asyncHandler(async (req, res) => {
    if (!deleteSetting(param(req, 'key'))) throw new HttpError(404, 'setting not found');
    res.json({ deleted: param(req, 'key') });
  }),
);
