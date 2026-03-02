const express = require('express');

const validate = require('../../middlewares/validate');
const adminValidation = require('../../validations/admin.validation');

const {adminController} = require('../../controllers');

const router = express.Router();

router.post('/loginAdmin', validate(adminValidation.loginAdmin), adminController.login);
router.post('/forgot-password', validate(adminValidation.forgotPassword), adminController.forgotPassword);
router.post('/reset-password', validate(adminValidation.resetPassword), adminController.resetPassword);
router.post(
  '/change-password',
  adminController.protect,
  validate(adminValidation.changePassword),
  adminController.changePassword
);

//user apis
router.get('/users', adminController.protect, adminController.userList);
router.get('/viewUser/:id', adminController.protect, adminController.viewUser);
router.get('/blockUnblockUser/:id', adminController.protect, adminController.blockUnblockUser);

//table apis
router.get('/archived-tables', adminController.protect, adminController.getArchivedTables);
router.get('/archived-tables/:id', adminController.protect, adminController.getArchivedTableById);

//table types
router.get('/table-types', adminController.protect, adminController.getTableTypes);
router.get('/table-types/:id', adminController.protect, adminController.getTableTypeById);
router.patch(
  '/table-types/:id',
  adminController.protect,
  validate(adminValidation.updateTableType),
  adminController.updateTableType
);
router.delete('/table-types/:id', adminController.protect, adminController.deleteTableType);
router.patch('/table-types/:id/toggle-status', adminController.protect, adminController.toggleTableTypeStatus);
router.post(
  '/table-types',
  adminController.protect,
  validate(adminValidation.addTableType),
  adminController.addTableType
);

module.exports = router;
