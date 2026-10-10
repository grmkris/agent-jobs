/**
 * The 3D view's scene: the only module that imports three, reached only through `import()` when a card turns a model,
 * so no page's first bundle carries it. Plain glTF/GLB (no Draco, KTX2 or meshopt decoders: nothing loaded from another
 * host, no wasm) and STL, softly lit, framed to fit, turning slowly unless motion is reduced; drag to orbit.
 */
import {
  Box3,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'

export interface ModelOptions {
  format: 'gltf' | 'stl'
  /** Where a glTF's relative files resolve. */
  base: string
  /** No turning: the person asked for less motion. */
  still: boolean
  /** An STL's colour (it carries none). */
  color: string
}

/** An STL as a solid mesh, turned from its Z-up convention to Y-up. */
function stlMesh(buffer: ArrayBuffer, color: string): Mesh {
  const geometry = new STLLoader().parse(buffer)
  geometry.computeVertexNormals()
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1 }))
  mesh.rotation.x = -Math.PI / 2
  return mesh
}

async function load(buffer: ArrayBuffer, options: ModelOptions): Promise<Object3D> {
  if (options.format === 'stl') return stlMesh(buffer, options.color)
  return (await new GLTFLoader().parseAsync(buffer, new URL('./', options.base).href)).scene
}

/** Frees the scene's geometry buffers; losing the context (below) frees whatever else it held on the GPU. */
function release(scene: Scene) {
  scene.traverse((node) => {
    if (node instanceof Mesh) node.geometry.dispose()
  })
}

/** Draws the model into the canvas until the returned function is called, which frees everything. */
export async function mountModel(canvas: HTMLCanvasElement, buffer: ArrayBuffer, options: ModelOptions) {
  const object = await load(buffer, options)
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  const scene = new Scene()
  scene.add(new HemisphereLight(0xffffff, 0x404040, 2.2))
  const key = new DirectionalLight(0xffffff, 2)
  key.position.set(3, 5, 4)
  scene.add(key)
  const box = new Box3().setFromObject(object)
  const size = box.getSize(new Vector3()).length() || 1
  object.position.sub(box.getCenter(new Vector3()))
  scene.add(object)
  const camera = new PerspectiveCamera(40, 1, size / 100, size * 100)
  camera.position.set(size * 0.8, size * 0.6, size * 1.2)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.enablePan = false
  controls.autoRotate = !options.still
  controls.autoRotateSpeed = 1.5
  const resize = () => {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)
    camera.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight)
    camera.updateProjectionMatrix()
  }
  resize()
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  renderer.setAnimationLoop(() => {
    controls.update()
    renderer.render(scene, camera)
  })
  return () => {
    renderer.setAnimationLoop(null)
    observer.disconnect()
    controls.dispose()
    release(scene)
    renderer.dispose()
    renderer.forceContextLoss()
  }
}
