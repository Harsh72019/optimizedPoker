const express = require('express');
const {tableController} = require('../../controllers');
const {tableValidation} = require('../../validations');
const validate = require('../../middlewares/validate');
const {protect} = require('../../controllers/admin.controller');
const router = express.Router();

router.post(
    '/createTable', 
    // protect, 
    validate(tableValidation.createTable),
    tableController.createTable
);

router.get(
    '/listTables',
    tableController.getAllTables
);

router.get(
    '/availableTables', 
    tableController.getAvailableTables
);

router.patch(
    '/updateTable/:id', 
    protect, 
    validate(tableValidation.updateTable), 
    tableController.updateTable
);

router.delete(
    '/deleteTable/:id', 
    protect,
    validate(tableValidation.deleteTable),
    tableController.deleteTable
);

router.post(
    '/findOrCreateTableType',
    protect,
    validate(tableValidation.findOrCreateTableType),
    tableController.findOrCreateTableType
);

router.get(
    '/getTableById/:id',
    tableController.getTableById
);
module.exports = router;