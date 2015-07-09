/* @flow */

var fs = require('fs');
var path = require('path');
var traceur = require('traceur');

require('traceur-source-maps').install(traceur);

function find_parent_package(filename) {
    var current = path.dirname(filename);
    while (true ) {
        var package_json = path.join(current, 'package.json');
        if (fs.existsSync(package_json))
            return require(package_json);
        var last_slash = current.lastIndexOf(path.sep);
        if (last_slash == -1) return null;
        current = current.substring(0, last_slash);
    }
}

traceur.require.makeDefault(
    function(filename) {
        if (filename.indexOf('package.json') > -1) return false;
        if (filename.indexOf('node_modules') === -1) return true;
        var p = find_parent_package(filename);
        return p && p.es6;
    }, 
    { asyncFunctions: true });
