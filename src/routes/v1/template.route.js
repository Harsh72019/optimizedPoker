// routes/admin.template.routes.js
const express = require('express');
const validate = require('../../middlewares/validate');
const {templateController} = require('../../controllers');
const {templateValidation} = require('../../validations');
const {protect} = require('../../controllers/admin.controller');
const router = express.Router();

router.use(protect); // Admin authentication

router.post('/create', validate(templateValidation.createTemplate), templateController.createTemplate);
router.get('/list', templateController.listTemplates);
router.get('/:id', validate(templateValidation.getTemplate), templateController.getTemplateById);
router.patch('/:id', validate(templateValidation.updateTemplate), templateController.updateTemplate);
router.delete('/:id', templateController.deleteTemplate);

module.exports = router;
