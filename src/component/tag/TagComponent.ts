/// <reference path="../../../typings/browser.d.ts" />

import * as THREE from "three";
import * as rx from "rx";
import * as vd from "virtual-dom";

import {Node} from "../../Graph";
import {Container, Navigator} from "../../Viewer";
import {APIv3} from "../../API";
import {ComponentService, Component, INodeTags, ITag, ITagData, TagSet} from "../../Component";
import {Transform} from "../../Geo";
import {RenderCamera, IVNodeHash, IGLRenderHash, GLRenderStage} from "../../Render";
import {IFrame} from "../../State";

interface IGlUpdateArgs {
    frame: IFrame;
    tags: ITag[];
}

export class TagComponent extends Component {
    public static componentName: string = "tag";

    private _activeTag$: rx.Subject<ITag>;
    private _claimMouse$: rx.Subject<void>;
    private _abortMouseClaim$: rx.Subject<void>;

    private _domSubscription: rx.IDisposable;
    private _glSubscription: rx.IDisposable;

    private _apiV3: APIv3;

    private _tagSet: TagSet;

    private _tags: ITag[];

    constructor(name: string, container: Container, navigator: Navigator) {
        super(name, container, navigator);

        this._activeTag$ = new rx.Subject<ITag>();
        this._claimMouse$ = new rx.Subject<void>();
        this._abortMouseClaim$ = new rx.Subject<void>();

        this._apiV3 = navigator.apiV3;

        this._tagSet = new TagSet();

        this._tags = null;
    }

    protected _activate(): void {
        this._claimMouse$
            .flatMapLatest(
                (): rx.Observable<MouseEvent> => {
                    return this._container.mouseService.mouseDragStart$
                        .takeUntil(this._abortMouseClaim$)
                        .take(1);
                })
            .subscribe(
                (e: MouseEvent): void => {
                    this._container.mouseService.claimMouse(this._name, 1);
                });

        this._container.mouseService.filtered$(this._name, this._container.mouseService.mouseDrag$)
            .withLatestFrom(
                this._activeTag$,
                (e: MouseEvent, tag: ITag): [MouseEvent, ITag] => {
                    return [e, tag];
                })
            .subscribe((et: [MouseEvent, ITag]): void => { return; });

        this._container.mouseService.filtered$(this._name, this._container.mouseService.mouseDragEnd$)
            .subscribe((e: MouseEvent): void => {
                this._container.mouseService.unclaimMouse(this._name);
             });

        this._navigator.stateService.currentState$
            .distinctUntilChanged(
                (frame: IFrame): string => {
                    return frame.state.currentNode.key;
                })
            .do(
                (frame: IFrame): void => {
                    this._tagSet.clearAll$.onNext(null);
                })
            .flatMapLatest<[string, ITag[]]>(
                (frame: IFrame): rx.Observable<[string, ITag[]]> => {
                    return rx.Observable
                        .fromPromise<any>(
                            this._apiV3.model
                                .get([
                                    "imageByKey",
                                    frame.state.currentNode.key,
                                    "ors",
                                    { from: 0, to: 20 },
                                    ["key", "obj", "rect", "value", "package", "score"],
                                ]))
                        .map<[string, ITag[]]>(
                            (ors: any): [string, ITag[]] => {
                                let nodeKey: string = frame.state.currentNode.key;
                                let tags: ITag[] = this._computeTags(frame.state.currentTransform, ors);

                                return [nodeKey, tags];
                            });
                })
            .subscribe(this._tagSet.set$);

        let tags$: rx.Observable<ITag[]> = this._navigator.stateService.currentNode$
            .flatMapLatest<ITag[]>(
                (node: Node): rx.Observable<ITag[]> => {
                    return this._tagSet.tagData$
                        .map<INodeTags>(
                            (tagData: ITagData): INodeTags => {
                                return tagData[node.key];
                            })
                        .map<ITag[]>(
                            (nodeTags: INodeTags): ITag[] => {
                                if (nodeTags == null) {
                                    return [];
                                }

                                let tags: ITag[] = [];

                                for (let key in nodeTags.approve) {
                                    if (nodeTags.approve.hasOwnProperty(key)) {
                                        tags.push(nodeTags.approve[key]);
                                    }
                                }

                                for (let key in nodeTags.change) {
                                    if (nodeTags.change.hasOwnProperty(key)) {
                                        tags.push(nodeTags.change[key]);
                                    }
                                }

                                for (let key in nodeTags.create) {
                                    if (nodeTags.create.hasOwnProperty(key)) {
                                        tags.push(nodeTags.create[key]);
                                    }
                                }

                                return tags;
                            });
                })
            .share();

        // le DOM render
        this._domSubscription = rx.Observable
            .combineLatest(
                this._container.renderService.renderCamera$,
                tags$,
                (rc: RenderCamera, tags: ITag[]): [RenderCamera, ITag[]] => {
                    return [rc, tags];
                })
            .map<IVNodeHash>(
                (rcts: [RenderCamera, ITag[]]): IVNodeHash => {
                    return {
                        name: this._name,
                        vnode: this._getRects(rcts[1], rcts[0].perspective),
                    };
                })
            .subscribe(this._container.domRenderer.render$);

        // le GL render
        this._glSubscription = rx.Observable
            .combineLatest(
                this._navigator.stateService.currentState$,
                tags$,
                (frame: IFrame, tags: ITag[]): IGlUpdateArgs => {
                    return { frame: frame, tags: tags };
                })
            .map<IGLRenderHash>(this._renderHash.bind(this))
            .subscribe(this._container.glRenderer.render$);
    }

    protected _deactivate(): void {
        this._domSubscription.dispose();
        this._glSubscription.dispose();
    }

    private _renderHash(args: IGlUpdateArgs): IGLRenderHash {
        // save tags for later when the render function will be called
        this._tags = args.tags;

        // return render hash with render function and
        // render in foreground.
        return {
            name: this._name,
            render: {
                frameId: args.frame.id,
                needsRender: false,
                render: this._render.bind(this),
                stage: GLRenderStage.Foreground,
            },
        };
    }

    private _computeTags(transform: Transform, ors: any): ITag[] {
        let tags: ITag[] = [];
        delete ors.json.imageByKey.$__path;
        ors = ors.json.imageByKey[Object.keys(ors.json.imageByKey)[0]].ors;
        delete ors.$__path;

        for (let key in ors) {
            if (ors.hasOwnProperty(key)) {
                let or: any = ors[key];
                if (or) {
                    let polygonBasic: number[][] = or.rect.geometry.coordinates;
                    let polygon3d: number[][] = this._polygonTo3d(transform, polygonBasic);

                    tags.push({
                        key: or.key,
                        object: or.obj,
                        package: or.package,
                        polygon3d: polygon3d,
                        polygonBasic: polygonBasic,
                        score: or.score,
                        value: or.value,
                    });
                }
            }
        }

        return tags;
    }

    private _polygonTo3d(transform: Transform, polygonBasic: number[][]): number[][] {
        let polygon3d: number[][] = polygonBasic.map((point: number[]) => {
            return transform.unprojectBasic(point, 200);
        });

        return polygon3d;
    }

    private _render(
        perspectiveCamera: THREE.PerspectiveCamera,
        renderer: THREE.WebGLRenderer): void {
        return;
    }

    private _projectToCanvas(point: THREE.Vector3, projectionMatrix: THREE.Matrix4): number[] {
        let projected: THREE.Vector3 =
            new THREE.Vector3(point.x, point.y, point.z)
                .applyProjection(projectionMatrix);

        return [(projected.x + 1) / 2, (-projected.y + 1) / 2];
    }

    private _convertToCameraSpace(point: number[], matrixWorldInverse: THREE.Matrix4): THREE.Vector3 {
        let p: THREE.Vector3 = new THREE.Vector3(point[0], point[1], point[2]);
        p.applyMatrix4(matrixWorldInverse);

        return p;
    }

    private _getRects(tags: ITag[], camera: THREE.PerspectiveCamera): vd.VNode {
        let vRects: vd.VNode[] = [];
        let matrixWorldInverse: THREE.Matrix4 = new THREE.Matrix4();
        matrixWorldInverse.getInverse(camera.matrixWorld);

        for (let t of tags) {
            let tag: ITag = t;

            let topLeftCamera: THREE.Vector3 = this._convertToCameraSpace(tag.polygon3d[1], matrixWorldInverse);
            let bottomRightCamera: THREE.Vector3 = this._convertToCameraSpace(tag.polygon3d[3], matrixWorldInverse);

            if (topLeftCamera.z > 0 && bottomRightCamera.z > 0) {
                continue;
            }

            let topLeft: number[] = this._projectToCanvas(topLeftCamera, camera.projectionMatrix);
            let bottomRight: number[] = this._projectToCanvas(bottomRightCamera, camera.projectionMatrix);

            let rect: number[] = [];
            rect[0] = topLeft[0];
            rect[1] = topLeft[1];
            rect[2] = bottomRight[0];
            rect[3] = bottomRight[1];

            let adjustedRect: number[] = this._coordsToCss(rect);

            let rectMapped: string[] = adjustedRect.map((el: number) => {
                return (el * 100) + "%";
            });

            let activateTag: (e: MouseEvent) => void = (e: MouseEvent): void => {
                this._activeTag$.onNext(tag);
                this._claimMouse$.onNext(null);
            };

            let abort: (e: MouseEvent) => void = (e: MouseEvent): void => {
                this._abortMouseClaim$.onNext(null);
            };

            let resize: vd.VNode = vd.h(
                "div",
                {
                    onmousedown: activateTag,
                    onmouseup: abort,
                    style: {
                        background: "red",
                        height: "20px",
                        left: "-20px",
                        position: "absolute",
                        top: "-20px",
                        width: "20px",
                    },
                },
                []);

            let label: vd.VNode = vd.h("span", { style: { color: "red" }, textContent: tag.value }, []);

            vRects.push(vd.h("div.Rect", { style: this._getRectStyle(rectMapped) }, [resize, label]));
        }

        return vd.h("div.rectContainer", {}, vRects);
    }

    private _coordsToCss(rects: number[]): number[] {
        let adjustedCoords: number[] = rects.concat();
        adjustedCoords[2] = 1 - adjustedCoords[2];
        adjustedCoords[3] = 1 - adjustedCoords[3];
        return adjustedCoords;
    }

    private _getRectStyle(mappedRect: Array<string>): string {
        return `top:${mappedRect[1]}; bottom:${mappedRect[3]}; right:${mappedRect[2]}; left:${mappedRect[0]}`;
    }
}

ComponentService.register(TagComponent);
export default TagComponent;