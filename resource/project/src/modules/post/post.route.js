'use strict';
const PostController = require( './post.controller' );
const AuthController = require('../auth/auth.controller');
const express = require( 'express' );
const router = express.Router();

router.get( '/', AuthController.checkLogin, PostController.getAll );
router.get( '/:id', AuthController.checkLogin, PostController.get );
router.post( '/', AuthController.checkLogin, PostController.insert );
router.put( '/:id', AuthController.checkLogin, PostController.update );
router.delete( '/:id', AuthController.checkLogin, PostController.delete );


module.exports = router;
