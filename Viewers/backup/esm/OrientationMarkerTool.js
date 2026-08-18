import vtkOrientationMarkerWidget from '@kitware/vtk.js/Interaction/Widgets/OrientationMarkerWidget';
import vtkAnnotatedCubeActor from '@kitware/vtk.js/Rendering/Core/AnnotatedCubeActor';
import vtkAxesActor from '@kitware/vtk.js/Rendering/Core/AxesActor';
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor';
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper';
import vtkXMLPolyDataReader from '@kitware/vtk.js/IO/XML/XMLPolyDataReader';
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData';
import { BaseTool } from './base';
import { Enums, eventTarget, getEnabledElementByIds, getRenderingEngines, } from '@cornerstonejs/core';
import { filterViewportsWithToolEnabled } from '../utilities/viewportFilters';
import { getToolGroup } from '../store/ToolGroupManager';
import { Events } from '../enums';
var OverlayMarkerType;
(function (OverlayMarkerType) {
    OverlayMarkerType[OverlayMarkerType["ANNOTATED_CUBE"] = 1] = "ANNOTATED_CUBE";
    OverlayMarkerType[OverlayMarkerType["AXES"] = 2] = "AXES";
    OverlayMarkerType[OverlayMarkerType["CUSTOM"] = 3] = "CUSTOM";
})(OverlayMarkerType || (OverlayMarkerType = {}));
class OrientationMarkerTool extends BaseTool {
    constructor(toolProps = {}, defaultToolProps = {
        configuration: {
            orientationWidget: {
                enabled: true,
                viewportCorner: vtkOrientationMarkerWidget.Corners.BOTTOM_RIGHT,
                viewportSize: 0.15,
                minPixelSize: 100,
                maxPixelSize: 300,
            },
            overlayMarkerType: OrientationMarkerTool.OVERLAY_MARKER_TYPES.ANNOTATED_CUBE,
            overlayConfiguration: {
                [OrientationMarkerTool.OVERLAY_MARKER_TYPES.ANNOTATED_CUBE]: {
                    faceProperties: {
                        xPlus: { text: 'L', faceColor: '#ffff00', faceRotation: 90 },
                        xMinus: { text: 'R', faceColor: '#ffff00', faceRotation: 270 },
                        yPlus: {
                            text: 'P',
                            faceColor: '#00ffff',
                            fontColor: 'white',
                            faceRotation: 180,
                        },
                        yMinus: { text: 'A', faceColor: '#00ffff', fontColor: 'white' },
                        zPlus: { text: 'S' },
                        zMinus: { text: 'I' },
                    },
                    defaultStyle: {
                        fontStyle: 'bold',
                        fontFamily: 'Arial',
                        fontColor: 'black',
                        fontSizeScale: (res) => res / 2,
                        faceColor: '#0000ff',
                        edgeThickness: 0.1,
                        edgeColor: 'black',
                        resolution: 400,
                    },
                },
                [OrientationMarkerTool.OVERLAY_MARKER_TYPES.AXES]: {},
                [OrientationMarkerTool.OVERLAY_MARKER_TYPES.CUSTOM]: {
                    polyDataURL: 'https://raw.githubusercontent.com/Slicer/Slicer/80ad0a04dacf134754459557bf2638c63f3d1d1b/Base/Logic/Resources/OrientationMarkers/Human.vtp',
                },
            },
        },
    }) {
        super(toolProps, defaultToolProps);
        this._resizeObservers = new Map();
        this.onSetToolEnabled = () => {
            this.initViewports();
            this._subscribeToViewportEvents();
        };
        this.onSetToolActive = () => {
            this.initViewports();
            this._subscribeToViewportEvents();
        };
        this.onSetToolDisabled = () => {
            this.cleanUpData();
            this._unsubscribeToViewportNewVolumeSet();
        };
        this._getViewportsInfo = () => {
            const viewports = getToolGroup(this.toolGroupId).viewportsInfo;
            return viewports;
        };
        this.resize = (viewportId) => {
            const orientationMarker = this.orientationMarkers[viewportId];
            if (!orientationMarker) {
                return;
            }
            const { orientationWidget } = orientationMarker;
            orientationWidget.updateViewport();
        };
        this.orientationMarkers = {};
        this.updatingOrientationMarker = {};
    }
    _unsubscribeToViewportNewVolumeSet() {
        const unsubscribe = () => {
            const viewportsInfo = this._getViewportsInfo();
            viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
                const { viewport } = getEnabledElementByIds(viewportId, renderingEngineId);
                const { element } = viewport;
                element.removeEventListener(Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME, this.initViewports.bind(this));
                const resizeObserver = this._resizeObservers.get(viewportId);
                resizeObserver.unobserve(element);
            });
        };
        // OHIF-AI LEAK FIX: this previously passed a FRESH inline arrow to
        // removeEventListener, which can never match the listener that was added — see the
        // companion fix in _subscribeToViewportEvents. Remove the stable instance reference.
        unsubscribe();
        if (this._toolGroupViewportAddedHandler) {
            eventTarget.removeEventListener(
                Events.TOOLGROUP_VIEWPORT_ADDED,
                this._toolGroupViewportAddedHandler
            );
            this._toolGroupViewportAddedHandler = null;
        }
    }
    _subscribeToViewportEvents() {
        const subscribeToElementResize = () => {
            const viewportsInfo = this._getViewportsInfo();
            viewportsInfo.forEach(({ viewportId, renderingEngineId }) => {
                const { viewport } = getEnabledElementByIds(viewportId, renderingEngineId);
                const { element } = viewport;
                this.initViewports();
                element.addEventListener(Enums.Events.VOLUME_VIEWPORT_NEW_VOLUME, this.initViewports.bind(this));
                const resizeObserver = new ResizeObserver(() => {
                    setTimeout(() => {
                        const element = getEnabledElementByIds(viewportId, renderingEngineId);
                        if (!element) {
                            return;
                        }
                        const { viewport } = element;
                        this.resize(viewportId);
                        viewport.render();
                    }, 100);
                });
                resizeObserver.observe(element);
                this._resizeObservers.set(viewportId, resizeObserver);
            });
        };
        subscribeToElementResize();
        // OHIF-AI LEAK FIX (upstream @cornerstonejs/tools bug).
        // This used to pass a FRESH inline arrow to addEventListener, and the matching
        // "removal" in _unsubscribeToViewportEvents passed ANOTHER fresh arrow — so nothing
        // was ever removed and every subscribe added one more TOOLGROUP_VIEWPORT_ADDED
        // listener to the global eventTarget. MEASURED: +1 per study open/close cycle,
        // monotonic, each a distinct closure with identical source.
        // Store a stable reference on the instance so remove can actually match it.
        if (this._toolGroupViewportAddedHandler) {
            eventTarget.removeEventListener(
                Events.TOOLGROUP_VIEWPORT_ADDED,
                this._toolGroupViewportAddedHandler
            );
        }
        this._toolGroupViewportAddedHandler = evt => {
            if (evt.detail.toolGroupId !== this.toolGroupId) {
                return;
            }
            subscribeToElementResize();
            this.initViewports();
        };
        eventTarget.addEventListener(
            Events.TOOLGROUP_VIEWPORT_ADDED,
            this._toolGroupViewportAddedHandler
        );
    }
    cleanUpData() {
        const renderingEngines = getRenderingEngines();
        const renderingEngine = renderingEngines[0];
        const viewports = renderingEngine.getViewports();
        viewports.forEach((viewport) => {
            const orientationMarker = this.orientationMarkers[viewport.id];
            if (!orientationMarker) {
                return;
            }
            const { actor, orientationWidget } = orientationMarker;
            orientationWidget?.setEnabled(false);
            orientationWidget?.delete();
            actor?.delete();
            const renderWindow = viewport
                .getRenderingEngine()
                .getOffscreenMultiRenderWindow(viewport.id)
                .getRenderWindow();
            renderWindow.render();
            viewport.getRenderingEngine().render();
            delete this.orientationMarkers[viewport.id];
        });
    }
    initViewports() {
        const renderingEngines = getRenderingEngines();
        const renderingEngine = renderingEngines[0];
        if (!renderingEngine) {
            return;
        }
        let viewports = renderingEngine.getViewports();
        viewports = filterViewportsWithToolEnabled(viewports, this.getToolName());
        viewports.forEach((viewport) => {
            const widget = viewport.getWidget(this.getToolName());
            if (!widget || widget.isDeleted()) {
                this.addAxisActorInViewport(viewport);
            }
        });
    }
    async addAxisActorInViewport(viewport) {
        const viewportId = viewport.id;
        if (!this.updatingOrientationMarker[viewportId]) {
            this.updatingOrientationMarker[viewportId] = true;
            const type = this.configuration.overlayMarkerType;
            const overlayConfiguration = this.configuration.overlayConfiguration[type];
            if (this.orientationMarkers[viewportId]) {
                const { actor, orientationWidget } = this.orientationMarkers[viewportId];
                viewport.getRenderer().removeActor(actor);
                orientationWidget.setEnabled(false);
            }
            let actor;
            if (type === 1) {
                actor = this.createAnnotationCube(overlayConfiguration);
            }
            else if (type === 2) {
                actor = vtkAxesActor.newInstance();
            }
            else if (type === 3) {
                actor = await this.createCustomActor();
            }
            const renderer = viewport.getRenderer();
            const renderWindow = viewport
                .getRenderingEngine()
                .getOffscreenMultiRenderWindow(viewportId)
                .getRenderWindow();
            const { enabled, viewportCorner, viewportSize, minPixelSize, maxPixelSize, } = this.configuration.orientationWidget;
            const orientationWidget = vtkOrientationMarkerWidget.newInstance({
                actor,
                interactor: renderWindow.getInteractor(),
                parentRenderer: renderer,
            });
            orientationWidget.setEnabled(enabled);
            orientationWidget.setViewportCorner(viewportCorner);
            orientationWidget.setViewportSize(viewportSize);
            orientationWidget.setMinPixelSize(minPixelSize);
            orientationWidget.setMaxPixelSize(maxPixelSize);
            orientationWidget.updateMarkerOrientation();
            this.orientationMarkers[viewportId] = {
                orientationWidget,
                actor,
            };
            viewport.addWidget(this.getToolName(), orientationWidget);
            renderWindow.render();
            viewport.getRenderingEngine().render();
            this.updatingOrientationMarker[viewportId] = false;
        }
    }
    async createCustomActor() {
        const url = this.configuration.overlayConfiguration[OverlayMarkerType.CUSTOM]
            .polyDataURL;
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const vtpReader = vtkXMLPolyDataReader.newInstance();
        vtpReader.parseAsArrayBuffer(arrayBuffer);
        vtpReader.update();
        const polyData = vtkPolyData.newInstance();
        polyData.shallowCopy(vtpReader.getOutputData());
        polyData.getPointData().setActiveScalars('Color');
        const mapper = vtkMapper.newInstance();
        mapper.setInputData(polyData);
        mapper.setColorModeToDirectScalars();
        const actor = vtkActor.newInstance();
        actor.setMapper(mapper);
        actor.rotateZ(180);
        return actor;
    }
    createAnnotationCube(overlayConfiguration) {
        const actor = vtkAnnotatedCubeActor.newInstance();
        actor.setDefaultStyle({ ...overlayConfiguration.defaultStyle });
        actor.setXPlusFaceProperty({
            ...overlayConfiguration.faceProperties.xPlus,
        });
        actor.setXMinusFaceProperty({
            ...overlayConfiguration.faceProperties.xMinus,
        });
        actor.setYPlusFaceProperty({
            ...overlayConfiguration.faceProperties.yPlus,
        });
        actor.setYMinusFaceProperty({
            ...overlayConfiguration.faceProperties.yMinus,
        });
        actor.setZPlusFaceProperty({
            ...overlayConfiguration.faceProperties.zPlus,
        });
        actor.setZMinusFaceProperty({
            ...overlayConfiguration.faceProperties.zMinus,
        });
        return actor;
    }
    async createAnnotatedCubeActor() {
        const axes = vtkAnnotatedCubeActor.newInstance();
        const { faceProperties, defaultStyle } = this.configuration.annotatedCube;
        axes.setDefaultStyle(defaultStyle);
        Object.keys(faceProperties).forEach((key) => {
            const methodName = `set${key.charAt(0).toUpperCase() + key.slice(1)}FaceProperty`;
            axes[methodName](faceProperties[key]);
        });
        return axes;
    }
}
OrientationMarkerTool.CUBE = 1;
OrientationMarkerTool.AXIS = 2;
OrientationMarkerTool.VTPFILE = 3;
OrientationMarkerTool.OVERLAY_MARKER_TYPES = OverlayMarkerType;
OrientationMarkerTool.toolName = 'OrientationMarker';
export default OrientationMarkerTool;
