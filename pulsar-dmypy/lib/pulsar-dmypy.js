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
		this.projects = new Map();
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
				} catch (err) {
					console.error("Shadow cleanup failed:", err);
				}
			}
		});
		this.projects.clear();
	},

	findProjectRoot(startDir) {
		let current = startDir;
		while (true) {
			if (
				fs.existsSync(path.join(current, 'pyproject.toml')) ||
				fs.existsSync(path.join(current, 'mypy.ini')) ||
				fs.existsSync(path.join(current, '.git'))
			) return current;
			const parent = path.dirname(current);
			if (parent === current) return startDir;
			current = parent;
		}
	},
	cleanupEmptyDirs(dir, stopDir) {
		while (dir !== stopDir) {
			if (!fs.existsSync(dir)) break;
			const files = fs.readdirSync(dir);
			if (files.length > 0) break;
			fs.rmdirSync(dir);
			dir = path.dirname(dir);
		}
	},
	buildShadowTree(projectRoot) {
		let project = this.projects.get(projectRoot);
		if (!project) {
			const shadowRoot = path.join(projectRoot, '.pulsar_dmypy_cache');
			fs.mkdirSync(shadowRoot, { recursive: true });
			project = {
				shadowRoot,
				isRunning: false,
				queueRequested: false
			};
			this.projects.set(projectRoot, project);
		}

		const shadowRoot = project.shadowRoot;

		const listRel = root => {
			const result = new Set();
			const walk = dir => {
				fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
					if (entry.name === '.pulsar_dmypy_cache') return;
					const full = path.join(dir, entry.name);
					const rel = path.relative(root, full);
					if (entry.isDirectory()) {
						walk(full);
					} else if (entry.isFile() && entry.name.endsWith('.py')) {
						result.add(rel);
					}
				});
			};
			if (fs.existsSync(root)) walk(root);
			return result;
		};

		const sourceSet = listRel(projectRoot);
		const shadowSet = listRel(shadowRoot);

		const editors = atom.workspace.getTextEditors();
		const openMap = new Map();
		editors.forEach(e => {
			if (e.getPath()) {
				const rel = path.relative(projectRoot, e.getPath());
				openMap.set(rel, e);
			}
		});

		// CREATE
		sourceSet.forEach(rel => {
			if (!shadowSet.has(rel)) {
				const sourcePath = path.join(projectRoot, rel);
				const shadowPath = path.join(shadowRoot, rel);
				fs.mkdirSync(path.dirname(shadowPath), { recursive: true });
				if (openMap.has(rel)) {
					fs.writeFileSync(shadowPath, openMap.get(rel).getText());
				} else {
					if (fs.existsSync(shadowPath)) fs.unlinkSync(shadowPath);
					fs.symlinkSync(sourcePath, shadowPath);
				}
			}
		});
		// DELETE
		shadowSet.forEach(rel => {
			if (!sourceSet.has(rel)) {
				const shadowPath = path.join(shadowRoot, rel);
				if (fs.existsSync(shadowPath)) {
					fs.unlinkSync(shadowPath);
					this.cleanupEmptyDirs(
						path.dirname(shadowPath),
						shadowRoot
					);
				}
			}
		});

		// UPDATE open buffers
		openMap.forEach((editor, rel) => {
			if (sourceSet.has(rel)) {
				const shadowPath = path.join(shadowRoot, rel);
				const sourcePath = path.join(projectRoot, rel);

				fs.mkdirSync(path.dirname(shadowPath), { recursive: true });

				if (fs.existsSync(shadowPath)) {
					const stat = fs.lstatSync(shadowPath);
					if (stat.isSymbolicLink()) {
						fs.unlinkSync(shadowPath);
					}
				}

				fs.writeFileSync(shadowPath, editor.getText());
			}
		});
		// FIX: replace non-open shadow files with symlink
		sourceSet.forEach(rel => {
			if (!openMap.has(rel)) {
				const shadowPath = path.join(shadowRoot, rel);
				const sourcePath = path.join(projectRoot, rel);

				if (fs.existsSync(shadowPath)) {
					const stat = fs.lstatSync(shadowPath);

					if (!stat.isSymbolicLink()) {
						// currently real file but should be symlink
						fs.unlinkSync(shadowPath);
						fs.symlinkSync(sourcePath, shadowPath);
					}
				}
			}
		});
	},

	runDmypy(shadowRoot) {
		return new Promise(resolve => {
			const proc = spawn('dmypy', ['run', '--', '--strict', '.'], { cwd: shadowRoot });
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
				const project = this.projects.get(projectRoot);

				if (project.isRunning) {
					project.queueRequested = true;
					return [];
				}

				project.isRunning = true;

				try {
					const output = await this.runDmypy(project.shadowRoot);

					const messages = [];
					const lines = output.split('\n');
					const regex = /^(.+?):(\d+):(?:(\d+):)?\s*(error|note|warning):\s*(.+)$/;
					const shadowFile = path.resolve(
						project.shadowRoot,
						path.relative(projectRoot, filePath)
					);

					lines.forEach(line => {
						const match = line.match(regex);
						if (!match) return;

						const errFile = path.resolve(project.shadowRoot, match[1]);
						if (errFile !== shadowFile) return;

						const row = parseInt(match[2]) - 1;
						const col = match[3] ? parseInt(match[3]) - 1 : 0;
						const severityRaw = match[4];
						const message = match[5];

						let severity = 'error';
						if (severityRaw === 'note') severity = 'info';
						if (severityRaw === 'warning') severity = 'warning';

						messages.push({
							severity,
							location: {
								file: filePath,
								position: [[row, col], [row, col + 1]]
							},
							excerpt: message
						});
					});

					return messages;

				} finally {
					project.isRunning = false;

					if (project.queueRequested) {
						project.queueRequested = false;
						atom.commands.dispatch(
							atom.views.getView(editor),
							'linter:lint'
						);
					}
				}
			}
		};
	}
};
