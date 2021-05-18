'use strict';
const SampleController = require( './sample.controller' );
const AuthController = require( '../auth/auth.controller' );
const express = require( 'express' );
const router = express.Router();

router.get( '/', AuthController.checkLogin, SampleController.getAll );
router.get( '/:id', AuthController.checkLogin, SampleController.get );
router.post( '/', AuthController.checkLogin, SampleController.insert );
router.put( '/:id', AuthController.checkLogin, SampleController.update );
router.delete( '/:id', AuthController.checkLogin, SampleController.delete );


module.exports = router;
