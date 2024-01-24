'use strict';
const { CalmController } = require( 'PATH_LINKsystem/core/CalmController' );
const { MODULE_SINGULAR_PASCALService } = require( './MODULE_SINGULAR_KEBAB.service' );
const { MODULE_SINGULAR_PASCAL } = require( './MODULE_SINGULAR_KEBAB.model' );
const MODULE_SINGULAR_CAMELDTO = require( './MODULE_SINGULAR_KEBAB.dto' );
const autoBind = require( 'auto-bind' ),
    MODULE_SINGULAR_CAMELService = new MODULE_SINGULAR_PASCALService(
        new MODULE_SINGULAR_PASCAL().getInstance()
    );

class MODULE_SINGULAR_PASCALController extends CalmController {

    constructor( service ) {
        super( service );
        this.dto = { ...this.dto, ...MODULE_SINGULAR_CAMELDTO };
        autoBind( this );
    }

}

module.exports = new MODULE_SINGULAR_PASCALController( MODULE_SINGULAR_CAMELService );
