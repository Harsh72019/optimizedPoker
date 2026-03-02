// controllers/tournamentTemplate.controller.js
const catchAsync = require('../utils/catchAsync');
const {templateService} = require('../services');
const httpStatus = require('http-status');

const createTemplate = catchAsync(async (req, res) => {
  const template = await templateService.createTemplate({
    ...req.body,
    adminId: req.admin._id,
  });

  res.status(httpStatus.CREATED).json({
    status: true,
    message: 'Tournament template created successfully',
    data: template,
  });
});

const listTemplates = catchAsync(async (req, res) => {
  const {status, search, ...otherOptions} = req.query;
  const templates = await templateService.listTemplates(status, search, otherOptions);

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Templates fetched successfully',
    data: templates,
  });
});

const getTemplateById = catchAsync(async (req, res) => {
  const template = await templateService.getTemplateById(req.params.id);

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Template fetched successfully',
    data: template,
  });
});

const updateTemplate = catchAsync(async (req, res) => {
  const template = await templateService.updateTemplate(req.params.id, req.body);

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Template updated successfully',
    data: template,
  });
});

const deleteTemplate = catchAsync(async (req, res) => {
  await templateService.deleteTemplate(req.params.id);

  res.status(httpStatus.OK).json({
    status: true,
    message: 'Template deleted successfully',
  });
});

module.exports = {
  createTemplate,
  listTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
};
