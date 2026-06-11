import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody } from './_helpers';
import { deleteSetting, getAllSettings, getSetting, setSetting } from '../db/settings';

export const settingsRouter = Router();

settingsRouter.get('/', (_req, res) => {
  res.json(getAllSettings());
});

settingsRouter.get(
  '/:key',
  asyncHandler(async (req, res) => {
    const value = getSetting(req.params.key);
    if (value === undefined) throw new HttpError(404, 'setting not found');
    res.json({ key: req.params.key, value });
  }),
);

const putBody = z.object({ value: z.unknown() });
settingsRouter.put(
  '/:key',
  asyncHandler(async (req, res) => {
    const { value } = parseBody(putBody, req);
    setSetting(req.params.key, value);
    res.json({ key: req.params.key, value });
  }),
);

settingsRouter.delete(
  '/:key',
  asyncHandler(async (req, res) => {
    if (!deleteSetting(req.params.key)) throw new HttpError(404, 'setting not found');
    res.json({ deleted: req.params.key });
  }),
);
