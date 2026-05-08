const fs = require('fs');
let c = fs.readFileSync('client/src/app/pages/quick-flows/quick-flows.ts', 'utf8');

const old = `\t\t\tgs.map((g) => (g.id === groupId ? { ...g, flows: [...g.flows, copy] } : g)),\r\n\t\t\t);\r\n\t\t\tthis.expandedGroupIds.set(new Set([groupId]));\r\n\t\t\tthis.startEditFlow(copy, groupId);`;

const rep = `\t\t\tgs.map((g) => {\r\n\t\t\t\tif (g.id !== groupId) return g;\r\n\t\t\t\tconst flows = [...g.flows];\r\n\t\t\t\tconst srcIdx = flows.findIndex((f) => f.id === flow.id);\r\n\t\t\t\tflows.splice(srcIdx === -1 ? flows.length : srcIdx + 1, 0, copy);\r\n\t\t\t\tnewIds = flows.map((f) => f.id);\r\n\t\t\t\treturn { ...g, flows };\r\n\t\t\t}),\r\n\t\t\t);\r\n\t\t\tif (newIds.length > 1) {\r\n\t\t\t\tfirstValueFrom(this.db.reorderQuickFlows(newIds)).catch(() => {});\r\n\t\t\t}\r\n\t\t\tthis.expandedGroupIds.set(new Set([groupId]));\r\n\t\t\tthis.startEditFlow(copy, groupId);`;

// Also need to add `let newIds: number[] = [];` before the groups.update call
const groupsUpdate = `\t\t\tthis.groups.update((gs) =>\r\n\t\t\t\t` + old;
const groupsRep = `\t\t\tlet newIds: number[] = [];\r\n\t\t\tthis.groups.update((gs) =>\r\n\t\t\t\t` + rep;

if (!c.includes(groupsUpdate)) { console.error('not found'); process.exit(1); }
c = c.replace(groupsUpdate, groupsRep);
fs.writeFileSync('client/src/app/pages/quick-flows/quick-flows.ts', c);
console.log('done');
