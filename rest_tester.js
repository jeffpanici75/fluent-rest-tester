import yaml from 'yamljs';
import moment from 'moment';
import should from 'should';
import crypto from 'crypto';
import uuid from 'node-uuid';
import pluralize from 'pluralize';
import url_template from 'url-template';

function random_string(length, chars) {
    chars = chars || 'abcdefghijklmnopqrstuwxyzABCDEFGHIJKLMNOPQRSTUWXYZ0123456789';

    var charsLength = chars.length;
    if (charsLength > 256) {
        throw new Error('Argument \'chars\' should not have more than 256 characters, otherwise unpredictability will be broken');
    }

    var randomBytes = crypto.randomBytes(length)
    var result = new Array(length);

    var cursor = 0;
    for (var i = 0; i < length; i++) {
        cursor += randomBytes[i];
        result[i] = chars[cursor % charsLength]
    };

    return result.join('');
}

function assert_self_link(result, def, api) {
    if (!def.uri) {
        return;
    }

    let params = {};
    if (result.resource.id)
        params[def.id_name] = result.resource.id;
    if (api && api.parent) {
        params[api.parent.id_name] = api.parent.parent_id;
    }
    let uri = def.uri.expand(params);
    if (result.resource.id)
        uri += '/';
    uri.should.be.exactly(result.resource._links.self.href).and.be.a.String();
}

function make_test_object(def, deps) {
    let o = {};
    let keys = Object.keys(def.fields);
    keys.forEach(y => {
        let f = def.fields[y];
        if (f.from) {
            if (f.from !== '<parent>') {
                let dependent = deps[f.from];
                if (!dependent) {
                    throw new Error(`Dependent resource missing for ${f.name}:${f.from}, deps=${JSON.stringify(deps)}.`);
                }
                o[f.name] = dependent.items[dependent.index].id;
                dependent.index++;
                if (dependent.index >= dependent.items.length)
                    dependent.index = 0;
            }
        } else if (f.values && f.values.length > 0) {
            let idx = Math.floor(Math.random() * f.values.length) + 0;
            o[f.name] = f.values[idx];
        } else {
            switch (f.type) {
                case 'number':
                    o[f.name] = Math.floor(Math.random() * 65536) + 0;
                    break;
                case 'string':
                    let len = f.max_length || 512;
                    o[f.name] = random_string(len);
                    break;
                case 'date':
                    o[f.name] = moment().format();
                    break;
                case 'uuid':
                    o[f.name] = uuid.v4();
                    break;
                case 'bool':
                    let value = Math.floor(Math.random() * 65536) + 1;                    
                    o[f.name] = value % 2 === 0 ? true : false;
                    break;
                case 'json':
                    o[f.name] = {};
                    break;
            }
        }
    });
    return o;
}

class field_def {
    static get valid_types() {
        return ['sequence', 'number', 'string', 'date', 'timestamp', 'json', 'uuid', 'bool'];
    }

    constructor(field) {
        this._field = field;
        this._name = Object.keys(this._field)[0];
        let options = this._field[this._name];
        if (!options.type)
            throw new Error('A field must have a type.');
        this._type = options.type;
        if (field_def.valid_types.indexOf(this._type) == -1)
            throw new Error(`Field type ${this._type} is not recognized.`);
        this._max_length = options.max_length || null;
        this._ignore = options.ignore || false;
        this._from = options.from || null;
        this._values = options.values || null;
    }

    get name() {
        return this._name;
    }

    get type() {
        return this._type;
    }

    get from() {
        return this._from;
    }

    get values() {
        return this._values;
    }

    get ignore() {
        return this._ignore;
    }

    get max_length() {
        return this._max_length;
    }
}

export default class fluent_rest_tester {
    constructor(api) {
        this._rest_api = api;
        this._config = null;
        this._all_defs = [];
    }

    load_config(path) {
        this._config = yaml.load(path);
        Object.keys(this._config.plural || {}).forEach(x => {
            pluralize.addPluralRule(x, this._config.plural[x]);
        });

        Object.keys(this._config.singular || {}).forEach(x => {
            pluralize.addSingularRule(x, this._config.singular[x]);
        });
        this._all_defs = create_resource_defs(this._config.resources);
    }

    run() {
        should.exist(this._all_defs);
        should.exist(this._rest_api);        
        test_resource_defs(this._all_defs, this._rest_api); 
    }

    static create_resource_defs(resources) {
        if (!resources || typeof resources !== 'object')
            return [];
        let resource_defs = [];
        Object.keys(resources).forEach(x => {
            let v = resources[x];
            if (v) {
                let resource_def = {
                    name: x,
                    fields: {},
                    enabled: true,
                    id_name: `${pluralize.singular(x)}_id`,
                    verbs: { get: true, post: true, put: true, patch: true, delete: true }
                };
                let keys = Object.keys(v);
                if (keys.indexOf('enabled') >= 0)
                    resource_def.enabled = v.enabled;
                if (v.uri)
                    resource_def.uri = url_template.parse(v.uri);
                resource_def.pre_existing_data = v.pre_existing_data;
                if (v.timeout)
                    resource_def.timeout = parseInt(v.timeout);
                if (v.verbs) {
                    Object.keys(resource_def.verbs).forEach(y => {
                        resource_def.verbs[y] = v.verbs.indexOf(y) !== -1;
                    });
                }
                if (v.fields) {
                    v.fields.forEach(f => {
                        if (typeof f !== 'object')
                            throw new Error('Fields must be objects.');
                        let field = new field_def(f);
                        resource_def.fields[field.name] = field;
                    });
                }
                resource_def.children = create_resource_defs(v.children);
                resource_defs.push(resource_def);
            }
        });
        return resource_defs;
    }

    get_dependent_resources(def, resources) {
        let keys = Object.keys(def.fields);
        keys.forEach(k => {
            let f = def.fields[k];
            if (!f.from || f.from === '<parent>')
                return;
            let func = this._rest_api[f.from];
            if (!func)
                throw new Error(`No client proxy for ${f.from}.`);
            let target_def = this._all_defs.find(x => x.name === f.from);
            if (!target_def)
                throw new Error(`No resource_def for ${f.from}.`);
            resources.unshift({ func, def: target_def, id_name: f.id || 'id' });
            this.get_dependent_resources(target_def, resources);
        });
    }

    create_dependent_resources(def, deps, done) {
        let resources = [];
        this.get_dependent_resources(def, resources);
        function next_resource(idx) {
            if (idx >= resources.length) {
                done();
                return;
            }
            let x = resources[idx];
            let obj = make_test_object(x.def, deps);
            x.func.apply(x.func).create(obj).then(result => {
                if (result.resource.message)
                    console.log('ERROR: %s, message = %s', x.def.name, result.resource.message);
                else {
                    let id = result.resource[x.id_name];
                    let temp = deps[x.def.name];
                    if (!temp) { 
                        temp = { items: [], index: 0 };
                        deps[x.def.name] = temp;
                    }
                    temp.items.push({ id, func: x.func });
                }
                next_resource(idx + 1);
            });
        }
        next_resource(0);
    }

    delete_dependent_resources(deps, done) {
        if (!deps) {
            done();
            return;
        }
        let items = [];
        Object.keys(deps).forEach(x => {
            items = items.concat(deps[x].items);
        });
        function delete_item(idx) {
            if (idx >= items.length) {
                done();
                return;
            }
            let x = items[idx];
            x.func.apply(x.func).delete_by_id(x.id).then(result => {
                delete_item(idx + 1);
            });
        }
        delete_item(0);
    }

    test_resource_defs(defs, api) {
        should.exist(defs);
        should.exist(api);

        defs.forEach(x => {
            if (!x.enabled)
                return;

            describe(`Resource '${x.name}' HTTP verbs`, function () {
                let resource_api;
                let deps;

                if (x.timeout)
                    this.timeout(x.timeout);

                before(done => {
                    api = typeof api === 'function' ? api() : api;
                    let func = api[x.name];
                    if (!func)
                        throw new Error(`Client resource ${api.name} is missing ${x.name}.`);
                    resource_api = func.apply(func, []);
                    
                    deps = {};
                    this.create_dependent_resources(x, deps, done);
                });

                if (x.verbs.get) {
                    describe('GET', () => {
                        if (x.pre_existing_data) {
                            describe('pre-existing resources', () => {
                                let first_page;
                                let total_count = 0;

                                it('should return first page', done => {
                                    resource_api.find()
                                        .then(result => {
                                            should.exist(result);
                                            should.exist(result.response);
                                            should.exist(result.resource);

                                            result.response.statusCode.should.be.exactly(200).and.be.a.Number();
                                            should.exist(result.response.headers['x-total-count']);
                                            total_count = parseInt(result.response.headers['x-total-count']);
                                            should.exist(result.resource._links);
                                            should.exist(result.resource._embedded);
                                           
                                            assert_self_link(result, x, resource_api);

                                            first_page = result.resource;

                                            done();
                                        })
                                        .catch(done);
                                });

                                it('should return all other pages', done => {
                                    function walk_pages(n) {
                                        if (n >= first_page._links.pages.length) {
                                            done();
                                            return;
                                        }
                                        this._rest_api.resource_at(first_page._links.pages[n].href)
                                            .then(result => {
                                                should.exist(result);
                                                should.exist(result.response);
                                                should.exist(result.resource);

                                                result.response.statusCode.should.be.exactly(200).and.be.a.Number();
                                                should.exist(result.response.headers['x-total-count']);
                                                parseInt(result.response.headers['x-total-count'])
                                                    .should
                                                    .be
                                                    .exactly(total_count)
                                                    .and
                                                    .be
                                                    .a
                                                    .Number();
                                                should.exist(result.resource._links);
                                                should.exist(result.resource._embedded);
                                                
                                                assert_self_link(result, x, resource_api);

                                                walk_pages(n + 1);
                                            })
                                            .catch(done);
                                    }
                                    if (!Array.isArray(first_page._links.pages))
                                        done();
                                    else
                                        walk_pages(1);
                                });
                            });
                        } else {
                            describe('no pre-existing resources', () => {
                                it('should return nothing', done => {
                                    resource_api.find()
                                        .then(result => {
                                            should.exist(result);
                                            should.exist(result.response);
                                            should.exist(result.resource);

                                            result.response.statusCode.should.be.exactly(200).and.be.a.Number();
                                            should.exist(result.response.headers['x-total-count']);
                                            let total_count = parseInt(result.response.headers['x-total-count']);
                                            total_count.should.be.exactly(0);
                                            should.exist(result.resource._links);
                                            should.not.exist(result.resource._links.pages);
                                            should.not.exist(result.resource._embedded);
                                            
                                            assert_self_link(result, x, resource_api);

                                            done();
                                        })
                                        .catch(done);
                                });
                            });
                        }
                    });
                }

                let id;

                if (x.verbs.post) {
                    describe('POST', () => {
                        it('should create a new resource', done => {                        
                            resource_api.create(make_test_object(x, deps))
                                .then(result => {
                                    should.exist(result);
                                    should.exist(result.response);
                                    should.exist(result.resource);
                                    should.not.exist(result.resource.message);

                                    result.response.statusCode.should.be.exactly(201).and.be.a.Number();
                                    should.exist(result.resource._links);
                                    should.not.exist(result.resource._links.pages);
                                    should.not.exist(result.resource._embedded);
                                    should.exist(result.resource.id);

                                    assert_self_link(result, x, resource_api);

                                    id = result.resource.id;

                                    done();
                                })
                                .catch(done);
                        });
                    });

                    if (x.children.length > 0) {
                        describe('CHILDREN', () => {
                            this.test_resource_defs(
                                x.children, 
                                () => {
                                    let func = api[pluralize.singular(x.name)];
                                    return func.apply(func, [id]);
                                });
                        });
                    }

                    if (x.verbs.put) {
                        describe('PUT', () => {
                            it('should update an existing resource', done => {
                                resource_api.update(id, make_test_object(x, deps))
                                    .then(result => {
                                        should.exist(result);
                                        should.exist(result.response);
                                        should.exist(result.resource);
                                        should.not.exist(result.resource.message);

                                        result.response.statusCode.should.be.exactly(200).and.be.a.Number();
                                        should.exist(result.resource._links);
                                        should.not.exist(result.resource._links.pages);
                                        should.not.exist(result.resource._embedded);
                                        should.exist(result.resource.id);

                                        assert_self_link(result, x, resource_api);

                                        id = result.resource.id;

                                        done();
                                    })
                                    .catch(done);
                            });
                        });
                    }

                    if (x.verbs.patch) {
                        describe('PATCH', () => {
                            it('should patch an existing resource', done => {
                                done();
                            });
                        });
                    }

                    if (x.verbs.delete) {
                        describe('DELETE', () => {
                            it('should delete newly created resource', done => {
                                resource_api.delete_by_id(id)
                                    .then(result => {
                                        should.exist(result);
                                        should.exist(result.response);
                                        should.exist(result.resource);
                                        should.not.exist(result.resource.message);

                                        result.response.statusCode.should.be.exactly(204).and.be.a.Number();
                                        should.not.exist(result.resource._links);
                                        should.not.exist(result.resource._embedded);

                                        done();
                                    })
                                    .catch(done);
                            });
                        });
                    }
                }

                after(done => {
                    this.delete_dependent_resources(deps, done);
                });
            });
        });
    }
}
