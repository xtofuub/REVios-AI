import ObjC from "frida-objc-bridge";
import { NSArray, NSData } from "../typings.js";
import { performOnMainThread } from "../lib/dispatch.js";
import coregraphics from "../native/coregraphics.js";
import uikit from "../native/uikit.js";

export interface AssetCatalogInfo {
  path: string;
  names: string[];
}

export interface AssetVariant {
  index: number;
  scale: number;
  width: number;
  height: number;
  isVector: boolean;
  isTemplate: boolean;
  hasSliceInfo: boolean;
  uti: string | null;
}

export interface AssetImageResult {
  png: string; // base64 encoded PNG
  width: number;
  height: number;
}

export interface AssetRawResult {
  filename: string;
  data: string; // base64
}

function loadFramework(path: string, name: string) {
  if (Process.findModuleByName(name)) return;
  const bundle = ObjC.classes.NSBundle.bundleWithPath_(path);
  if (!bundle) return;
  const errorPtr = Memory.alloc(Process.pointerSize).writePointer(NULL);
  bundle.loadAndReturnError_(errorPtr);
}

function coreUICatalogClass(): ObjC.Object {
  loadFramework("/System/Library/PrivateFrameworks/CoreUI.framework", "CoreUI");
  const { CUICatalog } = ObjC.classes;
  if (!CUICatalog) {
    throw new Error(
      "CUICatalog class not available. CoreUI framework not loaded.",
    );
  }
  return CUICatalog;
}

function openCatalogAtPath(path: string): ObjC.Object {
  const CUICatalog = coreUICatalogClass();
  const nsurl = ObjC.classes.NSURL.fileURLWithPath_(path);
  const errorPtr = Memory.alloc(Process.pointerSize).writePointer(NULL);
  const catalog = CUICatalog.alloc().initWithURL_error_(nsurl, errorPtr);

  const err = errorPtr.readPointer();
  if (!err.isNull()) {
    throw new Error(new ObjC.Object(err).localizedDescription().toString());
  }
  if (!catalog) {
    throw new Error("Failed to open asset catalog");
  }
  return catalog;
}

function openCatalog(path: string): ObjC.Object {
  const CUICatalog = coreUICatalogClass();
  const { NSBundle } = ObjC.classes;
  if (path === "default") {
    const mainBundle = NSBundle.mainBundle();
    const catalog = CUICatalog.defaultUICatalogForBundle_(
      mainBundle,
    );
    if (catalog) return catalog;

    const assetPath = mainBundle.pathForResource_ofType_("Assets", "car");
    if (assetPath) return openCatalogAtPath(assetPath.toString() as string);

    throw new Error("No default UI catalog");
  }

  return openCatalogAtPath(path);
}

function cgImageSize(cgImage: NativePointer): {
  width: number;
  height: number;
} {
  const { CGImageGetWidth, CGImageGetHeight } = coregraphics();
  return {
    width: CGImageGetWidth(cgImage),
    height: CGImageGetHeight(cgImage),
  };
}

function getImages(catalog: ObjC.Object, name: string): ObjC.Object[] {
  const arr = catalog.imagesWithName_(name) as NSArray;
  const count = arr.count();
  const result: ObjC.Object[] = [];
  for (let i = 0; i < count; i++) {
    result.push(arr.objectAtIndex_(i));
  }
  return result;
}

function openSync(path: string): AssetCatalogInfo {
  const catalog = openCatalog(path);
  const nsNames = catalog.allImageNames();
  const count = nsNames.count() as number;
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    names.push(nsNames.objectAtIndex_(i).toString() as string);
  }
  names.sort();

  return { path, names };
}

function variantsSync(path: string, name: string): AssetVariant[] {
  const catalog = openCatalog(path);
  const images = getImages(catalog, name);
  const { CUINamedData } = ObjC.classes;

  if (!CUINamedData) throw new Error("CUINamedData class not found");

  return images.map((img, index) => {
    const scale = img.scale() as number;
    const isVector = img.isVectorBased() as boolean;
    const isTemplate = img.isTemplate() as boolean;
    const hasSliceInfo = img.hasSliceInformation() as boolean;

    let width = 0;
    let height = 0;
    const cgImage = img.image();
    if (cgImage && !cgImage.isNull()) {
      ({ width, height } = cgImageSize(cgImage));
    }

    let uti: string | null = null;
    if (img.isKindOfClass_(CUINamedData)) {
      const u = img.utiType();
      if (u) uti = u.toString() as string;
    }

    return {
      index,
      scale,
      width,
      height,
      isVector,
      isTemplate,
      hasSliceInfo,
      uti,
    };
  });
}

function imageSync(
  path: string,
  name: string,
  index: number,
): AssetImageResult | null {
  const catalog = openCatalog(path);
  const images = getImages(catalog, name);
  if (index < 0 || index >= images.length) return null;

  const img = images[index];
  const cgImage = img.image();
  if (!cgImage || cgImage.isNull()) return null;

  const scale = img.scale() as number;

  const UIImage = ObjC.classes.UIImage;
  if (!UIImage) throw new Error("UIImage not available");

  const uiImage = UIImage.alloc().initWithCGImage_scale_orientation_(
    cgImage,
    scale,
    0,
  );
  if (!uiImage) return null;

  const { UIImagePNGRepresentation } = uikit();
  const pngPtr = UIImagePNGRepresentation(uiImage.handle);
  if (pngPtr.isNull()) return null;
  const pngData = new ObjC.Object(pngPtr);

  const length = pngData.length() as number;
  if (length === 0) return null;

  const { width, height } = cgImageSize(cgImage);
  return {
    png: pngData.base64EncodedStringWithOptions_(0).toString() as string,
    width,
    height,
  };
}

const UTI_EXT: Record<string, string> = {
  "public.png": "png",
  "public.jpeg": "jpg",
  "com.apple.icns": "icns",
  "com.microsoft.ico": "ico",
  "public.tiff": "tiff",
  "com.compuserve.gif": "gif",
  "public.svg-image": "svg",
  "com.adobe.pdf": "pdf",
  "org.webmproject.webp": "webp",
  "public.heic": "heic",
  "public.heif": "heif",
};

function extFromUTI(uti: string | null): string {
  if (!uti) return "png";
  return UTI_EXT[uti] ?? "png";
}

function rawImageSync(
  path: string,
  name: string,
  index: number,
): AssetRawResult | null {
  const catalog = openCatalog(path);
  const images = getImages(catalog, name);
  if (index < 0 || index >= images.length) return null;

  const img = images[index];
  const scale = img.scale() as number;
  const CUINamedData = ObjC.classes.CUINamedData;

  // If it's a CUINamedData, use its raw data and UTI directly
  if (CUINamedData && img.isKindOfClass_(CUINamedData)) {
    const nsData = img.data() as NSData;
    if (nsData) {
      const len = nsData.length() as number;
      if (len > 0) {
        const uti = img.utiType()?.toString() as string | undefined;
        const ext = extFromUTI(uti ?? null);
        const suffix = scale > 1 ? `@${scale}x` : "";
        return {
          filename: `${name}${suffix}.${ext}`,
          data: nsData.base64EncodedStringWithOptions_(0).toString() as string,
        };
      }
    }
  }

  console.log("[Assets download] fallback to png");

  // Fallback: re-encode CGImage as PNG
  const cgImage = img.image();
  if (!cgImage || cgImage.isNull()) return null;

  const UIImage = ObjC.classes.UIImage;
  if (!UIImage) throw new Error("UIImage not available");

  const uiImage = UIImage.alloc().initWithCGImage_scale_orientation_(
    cgImage,
    scale,
    0,
  );
  if (!uiImage) return null;

  const { UIImagePNGRepresentation } = uikit();
  const pngPtr = UIImagePNGRepresentation(uiImage.handle);
  if (pngPtr.isNull()) return null;
  const pngData = new ObjC.Object(pngPtr) as NSData;

  const length = pngData.length();
  if (length === 0) return null;

  const suffix = scale > 1 ? `@${scale}x` : "";
  return {
    filename: `${name}${suffix}.png`,
    data: pngData.base64EncodedStringWithOptions_(0).toString(),
  };
}

export function open(path: string): Promise<AssetCatalogInfo> {
  return performOnMainThread(() => openSync(path));
}

export function variants(path: string, name: string): Promise<AssetVariant[]> {
  return performOnMainThread(() => variantsSync(path, name));
}

export function image(
  path: string,
  name: string,
  index: number,
): Promise<AssetImageResult | null> {
  return performOnMainThread(() => imageSync(path, name, index));
}

export function rawImage(
  path: string,
  name: string,
  index: number,
): Promise<AssetRawResult | null> {
  return performOnMainThread(() => rawImageSync(path, name, index));
}
