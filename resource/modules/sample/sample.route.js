'use strict';
const MODULE_SINGULAR_PASCALController = require( './MODULE_SINGULAR_KEBAB.controller' );
const AuthController = require( 'PATH_LINKauth/auth.controller' );
const express = require( 'express' );
const router = express.Router();

router.use(AuthController.checkLogin);

router.get( '/', MODULE_SINGULAR_PASCALController.getAll );
router.get( '/:id', MODULE_SINGULAR_PASCALController.get );
router.post( '/', MODULE_SINGULAR_PASCALController.insert );
router.put( '/:id', MODULE_SINGULAR_PASCALController.update );
router.delete( '/:id', MODULE_SINGULAR_PASCALController.delete );


module.exports = router;

