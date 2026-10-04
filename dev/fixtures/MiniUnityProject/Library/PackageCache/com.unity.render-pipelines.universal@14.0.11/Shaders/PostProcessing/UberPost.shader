Shader "Hidden/Universal Render Pipeline/UberPost"
{
    HLSLINCLUDE
        TEXTURE2D_X(_SourceTex); TEXTURE2D_X(_Bloom_Texture); TEXTURE3D(_InternalLut);
        float4 _Lut_Params; float4 _Vignette_Params; float _Bloom_Intensity; float _Grain_Intensity; float _Chroma_Amount; float _PostExposure;
    ENDHLSL
}
