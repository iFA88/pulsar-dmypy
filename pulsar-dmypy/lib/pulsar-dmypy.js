/*!
	pulsar-dmypy
	Incremental MyPy integration for Pulsar
	Author: iFA
	https://github.com/iFA88/pulsar-dmypy
*/
'use babel';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
module.exports = {
	activate() {
		console.log("pulsar-dmypy activated");
		this.shadowRoot = null;
		// this.pendingLint = new Map();
		this.cleanupAllProjects();
		atom.project.onDidChangePaths(() => {
			this.cleanupAllProjects();
		});
		atom.workspace.onDidChangeActiveTextEditor(editor => {
			if (!editor) return;
			if (!editor.getPath() || !editor.getPath().endsWith('.py')) return;
			atom.commands.dispatch(atom.views.getView(editor), 'linter:lint');
		});
	},
	cleanupAllProjects() {
		const projectPaths = atom.project.getPaths();
		projectPaths.forEach(projectRoot => {
			const shadowPath = path.join(projectRoot, '.pulsar_dmypy_cache');
			if (fs.existsSync(shadowPath)) {
				try {
					fs.rmSync(shadowPath, { recursive: true, force: true });
					console.log("Shadow cache removed:", shadowPath);
				} catch (err) {
					console.error("Shadow cleanup failed:", err);
				}
			}
		});
	},
	findProjectRoot(startDir) {
		let current = startDir;
		while (true) {
			if (fs.existsSync(path.join(current, 'pyproject.toml')) || fs.existsSync(path.join(current, 'mypy.ini')) || fs.existsSync(path.join(current, '.git'))) return current;
			const parent = path.dirname(current);
			if (parent === current) return startDir;
			current = parent;
		}
	},
	buildShadowTree(projectRoot) {
		this.shadowRoot = path.join(projectRoot, '.pulsar_dmypy_cache');
		fs.rmSync(this.shadowRoot, { recursive: true, force: true });
		fs.mkdirSync(this.shadowRoot, { recursive: true });
		const editors = atom.workspace.getTextEditors();
		const openFiles = new Map();
		editors.forEach(e => {
			if (e.getPath()) openFiles.set(path.resolve(e.getPath()), e);
		});
		const walk = dir => {
			fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
				if (entry.name === '.pulsar_dmypy_cache') return;
				const fullPath = path.join(dir, entry.name);
				const relPath = path.relative(projectRoot, fullPath);
				const shadowPath = path.join(this.shadowRoot, relPath);
				if (entry.isDirectory()) {
					fs.mkdirSync(shadowPath, { recursive: true });
					walk(fullPath);
				} else if (entry.isFile() && entry.name.endsWith('.py')) {
					fs.mkdirSync(path.dirname(shadowPath), { recursive: true });
					if (openFiles.has(path.resolve(fullPath))) {
						const editor = openFiles.get(path.resolve(fullPath));
						fs.writeFileSync(shadowPath, editor.getText());
					} else {
						fs.symlinkSync(fullPath, shadowPath);
					}
				}
			});
		};
		walk(projectRoot);
	},
	runDmypy() {
		return new Promise(resolve => {
			const proc = spawn('dmypy', ['run', '--', '.'], { cwd: this.shadowRoot });
			let output = '';
			proc.stdout.on('data', data => output += data.toString());
			proc.stderr.on('data', data => output += data.toString());
			proc.on('close', () => resolve(output));
		});
	},
	provideLinter() {
		return {
			name: 'dmypy',
			scope: 'file',
			lintsOnChange: true,
			grammarScopes: ['source.python'],
			lint: async (editor) => {
				const filePath = editor.getPath();
				if (!filePath || !filePath.endsWith('.py')) return [];
				const projectRoot = this.findProjectRoot(path.dirname(filePath));
				if (!projectRoot) return [];
				this.buildShadowTree(projectRoot);
				const output = await this.runDmypy();
				const messages = [];
				const lines = output.split('\n');
				const regex = /^(.+?):(\d+):(?:(\d+):)?\s*error:\s*(.+)$/;
				const shadowFile = path.resolve(this.shadowRoot, path.relative(projectRoot, filePath));
				lines.forEach(line => {
					const match = line.match(regex);
					if (!match) return;
					const errFile = path.resolve(this.shadowRoot, match[1]);
					if (errFile !== shadowFile) return;
					const row = parseInt(match[2]) - 1;
					const col = match[3] ? parseInt(match[3]) - 1 : 0;
					const message = match[4];
					messages.push({
						severity: 'error',
						location: {
							file: filePath,
							position: [[row, col], [row, col + 1]]
						},
						excerpt: message
					});
				});
				return messages;
			}
		};
	},
};
