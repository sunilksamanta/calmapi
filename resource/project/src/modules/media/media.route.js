'use strict';
const MediaController = require( './media.controller' );
const express = require( 'express' ),
    router = express.Router();
const AuthController = require( '../auth/auth.controller' );

router.use(AuthController.checkLogin);

router.get( '/:id', MediaController.get );
router.post( '/', MediaController.upload.single( 'file' ), MediaController.insert );
router.delete( '/:id', MediaController.delete );


module.exports = router;
