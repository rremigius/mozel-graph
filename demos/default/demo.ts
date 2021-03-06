import cytoscape, {Collection, EventObject, NodeSingular} from "cytoscape";
import edgehandles from 'cytoscape-edgehandles';
// @ts-ignore
import contextMenus from 'cytoscape-context-menus';
import 'cytoscape-context-menus/cytoscape-context-menus.css';
// @ts-ignore
import fcose from "cytoscape-fcose";

import StandardGraphModel from "../../src/models/StandardGraphModel";
import style from "./style";
import StandardNodeMapping from "../../src/mappings/StandardNodeMapping";
import StandardEdgeMapping from "../../src/mappings/StandardEdgeMapping";
import NodeToEdgeMapping from "../../src/mappings/NodeToEdgeMapping";
import ModelFactory from "./ModelFactory";
import MozelSyncClient from "mozel-sync/dist/MozelSyncClient";
import DATA from "./server/data";
import {get} from "../../src/utils";
import Node from "./Node";
import StandardNodeModel from "../../src/models/StandardNodeModel";
import {check} from "validation-kit";
import {IS_INSTANCE_OF} from "validation-kit/dist/validators";
import MozelForm from "mozel-form";
import Edge from "./Edge";

cytoscape.use( edgehandles as any );
cytoscape.use( contextMenus );
cytoscape.use( fcose );

const session = window.location.hash.substring(1);

const data = session.length ? {gid: 'root'} : DATA;
const factory = new ModelFactory();
const model = factory.create(StandardGraphModel, data);
const client = new MozelSyncClient(model, 'http://localhost:3000', session);
client.sync.shouldSync = (model, syncID) => {
	const owner = get(model, 'owner');
	// Only sync models that 1) have no owner, 2) are changed by server or 3) are owned by the changing Sync
	return !owner || syncID === client.serverSyncID || owner === syncID;
};

const cy = cytoscape({
	container: document.getElementById('graph'),
	style: style
});

class NodeMapping extends StandardNodeMapping {
	get dataProperties() {
		return [...super.dataProperties, 'owner'];
	}
	isGrabbable(model: StandardNodeModel): boolean {
		const $model = check(model, IS_INSTANCE_OF(Node), 'model');
		return !$model.owner || $model.owner === client.sync.id;
	}
}
class EdgeMapping extends StandardEdgeMapping {
	get dataProperties() {
		return [...super.dataProperties, 'owner'];
	}
}
const nodeMapping = new NodeMapping(cy, model, model.nodes);
const edgeMapping = new EdgeMapping(cy, model, model.edges);
const linkMapping = new NodeToEdgeMapping(cy, model, model.nodes, 'link');

(cy as any).contextMenus({
	menuItems: [{
		id: 'edit',
		content: 'Edit',
		show: true,
		selector: 'node, edge',
		onClickFunction: (event:EventObject) => {
			const model = nodeMapping.getModel(event.target);
			showForm(model);
		}
	},{
		id: 'remove',
		content: 'Remove',
		show: true,
		selector: 'node, edge',
		onClickFunction: (event:EventObject) => {
			event.target.remove();
		}
	}, {
		id: 'addNode',
		content: 'Create Node',
		show: true,
		coreAsWell: true,
		onClickFunction: (event:EventObject) => {
			model.nodes.add({x: event.position.x, y: event.position.y });
		}
	}]
});
(cy as any).edgehandles({
	complete(source:NodeSingular, target:NodeSingular, created:Collection) {
		// Remove created elements - was just for visualisation until created in model
		created.remove();

		const sourceModel = nodeMapping.getModel(source);
		const targetModel = nodeMapping.getModel(target);
		if(!sourceModel || !targetModel) return;

		return model.edges.add({
			source: sourceModel,
			target: targetModel
		}, true);
	}
});

cy.ready(async ()=>{
	await client.start();
	window.location.hash = '#' + client.session;

	nodeMapping.start();
	edgeMapping.start();
	linkMapping.start();

	if(client.isSessionOwner) {
		setTimeout(() => {
			setLayout('fcose');
		});
	} else {
		cy.fit();
	}
});

function setLayout(layout:string) {
	cy.layout({
		name: layout,
		animate: true,
		idealEdgeLength: ()=>100
	} as any).run();
	document.querySelector('.layout-name').innerHTML = layout;
}

function showModal(title:string) {
	const modal = document.getElementById('modal');
	const header = document.getElementById('modal-title');

	header.innerHTML = title;
	modal.className = "show";

	modal.onclick = event => {
		if(event.target === modal) hideModal();
	}
}

function hideModal() {
	const modal = document.getElementById('modal');
	modal.className = "hide";
	modal.onclick = null;
}

class NodeForm extends MozelForm {
	static Model = Node;
	static definition = {
		startExpanded: true,
		fields: [
			'title',
			{property: 'description', input: 'textarea'},
			'url']
	}
}


function showForm(model:Node|Edge) {
	const factory = NodeForm.create<NodeForm>(model);
	const container = document.getElementById('modal-content');
	factory.mount(container);
	showModal("Form");
}

(window as any).graph = {
	setLayout
}
