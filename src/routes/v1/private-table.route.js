const express = require("express");

const validate = require("../../middlewares/validate");
const { protect } = require("../../controllers/auth.controller");

const privateTableValidation = require("../../validations/private-table.validation");
const privateTableController = require("../../controllers/private-table.controller");

const router = express.Router();

/* ------------------------------------------------ */
/* CREATE + LIST AVAILABLE TABLES */
/* ------------------------------------------------ */

router
  .route("/")
  .post(
    protect,
    validate(privateTableValidation.createPrivateTable),
    privateTableController.createPrivateTable
  )
  .get(
    // validate(privateTableValidation.getAvailableTables),
    protect,
    privateTableController.getAvailableTables
  );

/* ------------------------------------------------ */
/* TEST CREATE (NO AUTH) */
/* ------------------------------------------------ */

router.post(
  "/test",
  validate(privateTableValidation.createPrivateTable),
  (req, res, next) => {
    // Mock user for testing
    req.user = { id: 'test_host_123' };
    next();
  },
  privateTableController.createPrivateTable
);


/* ------------------------------------------------ */
/* HOST TABLES */
/* ------------------------------------------------ */

router.get(
  "/host",
  protect,
  validate(privateTableValidation.getHostTables),
  privateTableController.getHostTables
);


/* ------------------------------------------------ */
/* TABLE DETAILS */
/* ------------------------------------------------ */

router.get(
  "/:tableId",
  validate(privateTableValidation.getPrivateTable),
  privateTableController.getPrivateTable
);


/* ------------------------------------------------ */
/* JOIN TABLE */
/* ------------------------------------------------ */

router.post(
  "/:tableId/join",
  protect,
  validate(privateTableValidation.joinPrivateTable),
  privateTableController.joinPrivateTable
);


/* ------------------------------------------------ */
/* START TABLE */
/* ------------------------------------------------ */

router.post(
  "/:tableId/start",
  protect,
  validate(privateTableValidation.startPrivateTable),
  privateTableController.startPrivateTable
);


/* ------------------------------------------------ */
/* LEAVE TABLE */
/* ------------------------------------------------ */

router.post(
  "/:tableId/leave",
  protect,
  validate(privateTableValidation.leavePrivateTable),
  privateTableController.leavePrivateTable
);


/* ------------------------------------------------ */
/* CANCEL TABLE */
/* ------------------------------------------------ */

router.post(
  "/:tableId/cancel",
  protect,
  validate(privateTableValidation.cancelTable),
  privateTableController.cancelTable
);


module.exports = router;