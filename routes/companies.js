'use strict';

const express = require('express');

function createTopSuppliersRouter({ pool }) {
    const router = express.Router();

    router.get('/', async (req, res, next) => {
        try {
            const { rows } = await pool.query(`
                SELECT
                    c.id,
                    c.company,
                    c.specialization,
                    c.city,
                    c.verified_by_platform,
                    COUNT(p.id)                                           AS total_proposals,
                    COUNT(p.id) FILTER (WHERE p.status = 'Принято')      AS won_deals
                FROM companies c
                LEFT JOIN proposals p ON p.company = c.company
                WHERE c.role = 'producer'
                GROUP BY c.id
                ORDER BY won_deals DESC, total_proposals DESC
                LIMIT 5
            `);
            res.json(rows.map(r => ({
                id:         r.id,
                company:    r.company,
                spec:       r.specialization || '',
                city:       r.city || '',
                verified:   r.verified_by_platform,
                deals:      Number(r.won_deals),
                proposals:  Number(r.total_proposals),
            })));
        } catch (e) { next(e); }
    });

    return router;
}

function createCompaniesRouter(deps) {
    const {
        pool,
        storage,
        requireAuth,
        optionalAuth,
        handlePhotoUpload,
        rowToCompany,
        enrichCompany,
        geocodeCity,
    } = deps;

    const router = express.Router();

    router.get('/', optionalAuth, async (req, res, next) => {
        try {
            const ownerCompany = req.user ? req.user.company : null;
            const { rows } = await pool.query('SELECT * FROM companies');
            const enriched = await Promise.all(rows.map(r => enrichCompany(rowToCompany(r), ownerCompany)));
            res.json(enriched);
        } catch (e) { next(e); }
    });

    router.get('/:id', optionalAuth, async (req, res, next) => {
        try {
            const { rows: [row] } = await pool.query('SELECT * FROM companies WHERE id = $1', [Number(req.params.id)]);
            if (!row) return res.status(404).json({ error: 'Компания не найдена' });
            res.json(await enrichCompany(rowToCompany(row), req.user ? req.user.company : null));
        } catch (e) { next(e); }
    });

    router.put('/:id', requireAuth, async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const { rows: [row] } = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
            if (!row) return res.status(404).json({ error: 'Компания не найдена' });
            if (row.company !== req.user.company) return res.status(403).json({ error: 'Можно редактировать только профиль своей компании' });

            const { city, yearsExperience, about, equipment, specialization, phone, website,
                    ogrn, director, foundingYear, authorizedCapital, employees, revenue,
                    machinesCount, productionArea, videoUrl,
                    isoCertificates, qualityCertificates, capabilities, productionLoad } = req.body;

            const str  = (v, max) => String(v).slice(0, max);
            const num  = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; };

            const sets = [], vals = [];
            const f = (col, val) => { sets.push(`${col} = $${sets.length + 1}`); vals.push(val); };

            if (city !== undefined) {
                const cityVal = str(city, 100);
                f('city', cityVal);
                if (cityVal !== row.city) {
                    geocodeCity(cityVal).then(coords => {
                        if (coords) pool.query('UPDATE companies SET lat=$1,lng=$2 WHERE id=$3', [coords.lat, coords.lng, id]);
                        else pool.query('UPDATE companies SET lat=NULL,lng=NULL WHERE id=$1', [id]);
                    });
                }
            }
            if (yearsExperience !== undefined)    f('years_experience', num(yearsExperience));
            if (about !== undefined)              f('about', str(about, 1000));
            if (specialization !== undefined)     f('specialization', str(specialization, 200));
            if (phone !== undefined)              f('phone', str(phone, 30));
            if (website !== undefined)            f('website', str(website, 200));
            if (ogrn !== undefined)               f('ogrn', str(ogrn, 20));
            if (director !== undefined)           f('director', str(director, 150));
            if (foundingYear !== undefined)       f('founding_year', num(foundingYear));
            if (authorizedCapital !== undefined)  f('authorized_capital', str(authorizedCapital, 50));
            if (employees !== undefined)          f('employees', num(employees));
            if (revenue !== undefined)            f('revenue', str(revenue, 50));
            if (machinesCount !== undefined)      f('machines_count', num(machinesCount));
            if (productionArea !== undefined)     f('production_area', num(productionArea));
            if (videoUrl !== undefined)           f('video_url', str(videoUrl, 300));
            if (productionLoad !== undefined) {
                const n = Number(productionLoad);
                f('production_load', Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null);
            }
            if (Array.isArray(equipment))           f('equipment', JSON.stringify(equipment.map(e => str(e, 60)).slice(0, 20)));
            if (Array.isArray(isoCertificates))     f('iso_certificates', JSON.stringify(isoCertificates.map(e => str(e, 80)).slice(0, 20)));
            if (Array.isArray(qualityCertificates)) f('quality_certificates', JSON.stringify(qualityCertificates.map(e => str(e, 80)).slice(0, 20)));
            if (Array.isArray(capabilities))        f('capabilities', JSON.stringify(capabilities.slice(0, 20)));
            if (req.body.freeCapacity !== undefined) {
                const cap = Array.isArray(req.body.freeCapacity) ? req.body.freeCapacity : [];
                const valid = cap
                    .filter(c => c && typeof c.name === 'string' && c.name.trim())
                    .map(c => ({ name: String(c.name).slice(0, 80), percent: Math.min(100, Math.max(0, Number(c.percent) || 0)) }))
                    .slice(0, 15);
                f('free_capacity', JSON.stringify(valid));
            }

            if (sets.length) {
                vals.push(id);
                await pool.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
            }

            const { rows: [updated] } = await pool.query('SELECT * FROM companies WHERE id = $1', [id]);
            res.json(await enrichCompany(rowToCompany(updated), req.user.company));
        } catch (e) { next(e); }
    });

    router.post('/:id/photos', requireAuth, handlePhotoUpload, async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const { rows: [row] } = await pool.query('SELECT company FROM companies WHERE id = $1', [id]);
            if (!row) return res.status(404).json({ error: 'Компания не найдена' });
            if (row.company !== req.user.company) return res.status(403).json({ error: 'Можно загружать фото только своей компании' });
            if (!req.file) return res.status(400).json({ error: 'Файл не передан' });

            const { rows: [{ n: count }] } = await pool.query('SELECT COUNT(*) AS n FROM company_photos WHERE company_id = $1', [id]);
            if (count >= 10) return res.status(400).json({ error: 'Максимум 10 фотографий' });

            const meta = await storage.saveFile(req.file, 'photos');
            const { rows: [photo] } = await pool.query(
                'INSERT INTO company_photos (company_id, stored_name, original_name) VALUES ($1, $2, $3) RETURNING *',
                [id, meta.storedName, meta.originalName]
            );
            res.status(201).json({
                id: photo.id,
                storedName: photo.stored_name,
                originalName: photo.original_name,
                url: storage.photoPublicUrl(photo.stored_name),
            });
        } catch (e) { next(e); }
    });

    router.delete('/:id/photos/:photoId', requireAuth, async (req, res, next) => {
        try {
            const id = Number(req.params.id);
            const photoId = Number(req.params.photoId);
            const { rows: [row] } = await pool.query('SELECT company FROM companies WHERE id = $1', [id]);
            if (!row) return res.status(404).json({ error: 'Компания не найдена' });
            if (row.company !== req.user.company) return res.status(403).json({ error: 'Нет прав' });

            const { rows: [photo] } = await pool.query('SELECT stored_name FROM company_photos WHERE id = $1 AND company_id = $2', [photoId, id]);
            if (!photo) return res.status(404).json({ error: 'Фото не найдено' });

            await pool.query('DELETE FROM company_photos WHERE id = $1', [photoId]);
            storage.deleteStored(photo.stored_name).catch(() => {});
            res.json({ message: 'Удалено' });
        } catch (e) { next(e); }
    });

    return router;
}

module.exports = createCompaniesRouter;
module.exports.createTopSuppliersRouter = createTopSuppliersRouter;
