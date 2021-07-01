import cytoscape from "cytoscape";
import Mozel, {deep, immediate} from "mozel";
import {alphanumeric} from "validation-kit";
import {debounce, forEach, includes, isPlainObject} from "lodash";

import log from "./Log";
// @ts-ignore
import fcose from "cytoscape-fcose";
import {MozelData} from "mozel/dist/Mozel";
import EntityModel from "./models/EntityModel";
import PropertyWatcher from "mozel/dist/PropertyWatcher";
import GraphModelAbstract from "./models/GraphModelAbstract";

cytoscape.use(fcose);

export type GraphOptions = {
	elementData?:(entity:EntityModel)=>object;
};

export default abstract class GraphAbstract<G extends GraphModelAbstract<N,R>, N extends Mozel, R extends Mozel> {
	static get cytoscape() {
		return cytoscape;
	}

	private debouncedLayout = debounce(this.applyLayout.bind(this));
	private updatesNextTick:Record<alphanumeric, N|R> = {};
	private readonly initializing:Promise<any> = undefined;
	private readonly options:GraphOptions;

	/**
	 * Returns whether the Graph has been setup and is ready to take data.
	 */
	public get initialized() {
		return this.initializing;
	}

	public readonly cy:cytoscape.Core;
	public _model:G;
	public get model() {
		return this._model;
	}
	public set model(model:G) {
		this.setModel(model);
	}

	private watchers:PropertyWatcher[] = [];

	protected constructor(options?:cytoscape.CytoscapeOptions & GraphOptions) {
		options = options || {};
		this.options = options;

		this.cy = cytoscape(options);
		this.initInteractions();

		// Use options
		if (options.style instanceof Promise) {
			this.initializing = options.style;
		}
	}

	initInteractions() {
		// When a node is dropped
		this.cy.on('free', event => {
			this.fixNodeElement(event.target);
		});
	}

	initWatchers(model:G) {
		const nodesPath = this.model.getGraphModelNodesPath();
		const relationsPath = this.model.getGraphModelRelationsPath();
		// Watch nodes
		this.watchers.push(
			model.$watch(nodesPath + '.*', () => {
				this.updateNodes();
			}, {debounce: 0, immediate})
		);

		// Watch relations
		this.watchers.push(
			model.$watch(relationsPath + '.*', () => {
				this.updateRelations();
			}, {debounce: 0, immediate})
		);

		// Watch node properties
		this.watchers.push(
			model.$watch(nodesPath + '.*', ({newValue, oldValue}) => {
				// These changes are for the shallow watcher to handle
				if(!this.model.isNode(newValue) || !this.model.isNode(oldValue)) return;
				if(newValue.gid !== oldValue.gid) return;

				this.updateNextTick(newValue);
			}, {deep, immediate})
		);

		// Watch relation properties
		this.watchers.push(
			this.model.$watch(relationsPath + '.*', ({newValue, oldValue}) => {
				// These changes are for the shallow watcher to handle
				if(!this.model.isRelation(newValue) || !this.model.isRelation(oldValue)) return;
				if(newValue.gid !== oldValue.gid) return;

				this.updateNextTick(newValue);
			}, {deep, immediate})
		);
	}

	deinitWatchers(model:G) {
		for(let watcher of this.watchers) {
			model.$removeWatcher(watcher);
		}
	}

	setModel(model:G) {
		if(this.model) {
			this.deinitWatchers(this.model);
		}
		this._model = model;
		this.initWatchers(model);
	}

	setData(data:MozelData<G>) {
		log.log("Setting data", data);
		if(!this.model) {
			log.log("Creating model", data);
			const model = this.createModel(data);
			this.setModel(model);
			return;
		}
		this.model.$setData(data);
	}

	updateNodes() {
		log.log("Updating nodes");

		// Remove node elements that have no counterpart in model
		this.cy.nodes()
			.filter(node => !this.getNodeModel(node))
			.remove();

		// Create missing node elements for node models
		this.model.getNodes().each(node => {
			if(!this.model.isNode(node)) {
				log.error("Invalid node:", node);
				return;
			}

			const el = this.getNodeElement(node);
			if(!el || !el.length) {
				this.addNodeElement(node);
			}
		});

		this.debouncedLayout();
	}

	updateNextTick(entity:N|R) {
		log.log(`Updating entity next tick: ${entity}`);
		this.updatesNextTick[entity.gid] = entity;

		setTimeout(()=>{
			const numUpdates = Object.keys(this.updatesNextTick).length;
			if(!numUpdates) return; // already done

			log.log(`Applying ${numUpdates} scheduled updates this tick.`);

			for(let gid in this.updatesNextTick) {
				const entity = this.updatesNextTick[gid];
				if(this.model.isNode(entity)) this.updateNodeElement(entity);
				if(this.model.isRelation(entity)) this.updateEdgeElement(entity);
			}
			// Clear updates
			this.updatesNextTick = {};
		})
	}

	updateNodeElement(node:N) {
		log.log(`Updating node element: ${node}`);
		const ele = this.getNodeElement(node);
		if(!ele) {
			log.error(`No node element found for ${node}`);
			return;
		}

		// Set position
		const position = this.model.getPosition(node);
		ele.position({x: position.x || 0, y: position.y || 0});

		// Set data
		let data = this.getElementData(node);
		if(!isPlainObject(data)) data = {};
		forEach(data, (value, key) => {
			if(includes(['id', 'classes', 'gid'], key)) return; // reserved keys
			ele.data(key, value);
		});

		// Set GID
		ele.data('gid', node.gid);
	}

	updateEdgeElement(relation:R) {
		log.log(`Updating edge element: ${relation}`);
		const ele = this.getEdgeElement(relation);
		if(!ele) {
			log.error(`No edge element found for ${relation}`);
			return;
		}

		// Set data
		let data = this.getElementData(relation);
		if(!isPlainObject(data)) data = {};
		forEach(data, (value, key) => {
			if(includes(['id', 'classes', 'source', 'target', 'gid'], key)) return; // reserved keys
			ele.data(key, value);
		});

		// Set GID
		ele.data('gid', relation.gid);
	}

	updateRelations() {
		log.log("Updating relations");

		// Remove relation elements that have no counterpart in model
		this.cy.edges()
			.filter(edge => !this.getRelationModel(edge))
			.remove();

		// Create missing edge elements for relation models
		this.model.getRelations().each(relation => {
			if(!this.model.isRelation(relation)) {
				log.error("Invalid relation:", relation);
				return;
			}
			const el = this.getEdgeElement(relation);
			if(!el || !el.length) {
				this.addEdgeElement(relation);
			}
		});

		this.debouncedLayout();
	}

	async applyLayout() {
		const elements = this.cy.filter(ele => {
			if(ele.isNode()) return !this.isFixedNodeElement(ele);
			if(ele.isEdge()) return !this.isFixedEdgeElement(ele);
			return false;
		});
		log.log(`Applying layout to ${elements.nodes().length} nodes.`);

		const options = {
			name: 'fcose',
			fit: elements.nodes().length === this.cy.nodes().length // don't fit when applying partial layout
		} as any; // TS: otherwise BaseLayout does not accept enough options

		const layout = elements.layout(options);
		layout.run();

		await layout.promiseOn('layoutstop');
		this.fixNodeElements(elements.nodes());
	}

	fixNodeElements(nodes:cytoscape.NodeCollection) {
		nodes.each(ele => {
			this.fixNodeElement(ele);
		});
	}

	fixNodeElement(ele:cytoscape.NodeSingular) {
		const node = this.getNodeModel(ele);
		log.log(`Fixing node: ${node}`);

		if(!node) return;
		const {x, y} = ele.position();
		this.model.setPosition(node, x, y);
		this.model.setFixed(node, true);
		return node;
	}

	addNodeElement(node:N) {
		log.log(`Adding node element: ${node}`);
		const ele = this.cy.add({
			group: 'nodes',
			data: {
				id: this.getId(node)
			}
		});
		this.updateNodeElement(node);
		return ele;
	}

	addEdgeElement(relation:R) {
		log.log(`Adding edge element: ${relation}`);
		const ele = this.cy.add({
			group: 'edges',
			data: {
				id: this.getId(relation),
				source: this.getId(this.model.getRelationSource(relation)),
				target: this.getId(this.model.getRelationTarget(relation))
			}
		});
		this.updateEdgeElement(relation);
		return ele;
	}

	getNodeModel(nodeElement:cytoscape.NodeSingular) {
		return this.model.getNodes().find(node => this.model.isNode(node) && this.getId(node) === nodeElement.id()) as N;
	}

	getRelationModel(edge:cytoscape.EdgeSingular) {
		return this.model.getRelations().find(relation => this.model.isRelation(relation) && this.getId(relation) === edge.id()) as R;
	}

	isFixedNodeElement(ele:cytoscape.NodeSingular) {
		return this.model.isFixed(this.getNodeModel(ele));
	}

	isFixedEdgeElement(ele:cytoscape.EdgeSingular) {
		const source = ele.source();
		const target = ele.target();
		return this.isFixedNodeElement(source) && this.isFixedNodeElement(target);
	}

	getNodeElement(node:N):cytoscape.NodeSingular|undefined {
		const ele = this.cy.getElementById(this.getId(node));
		return ele.isNode() ? ele : undefined;
	}

	getEdgeElement(relation:R):cytoscape.EdgeSingular|undefined {
		const ele = this.cy.getElementById(this.getId(relation));
		return ele.isEdge() ? ele : undefined;
	}

	getId(entity:N|R):string {
		return entity.gid.toString();
	}

	// For override

	abstract createModel(data:MozelData<G>):G;
	abstract getElementData(entity:N|R):object;
}